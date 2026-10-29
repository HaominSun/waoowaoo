import { createHash, randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { logError as _ulogError } from '@/lib/logging/core'
import { getLogContext } from '@/lib/logging/context'
import { prisma } from '@/lib/prisma'
import { parseModelKeyStrict } from '@/lib/model-config-contract'
import {
  calcImage,
  calcLipSync,
  calcText,
  calcVideo,
  calcVideoByTokens,
  calcVoice,
  calcVoiceDesign,
  type ModelCustomPricing,
} from './cost'
import {
  confirmChargeWithRecord,
  freezeBalance,
  getBalance,
  getFreezeByIdempotencyKey,
  increasePendingFreezeAmount,
  recordShadowUsage,
  rollbackFreeze,
} from './ledger'
import {
  confirmOrganizationChargeWithRecord,
  freezeOrganizationBalance,
  getOrganizationBalance,
  increaseOrganizationPendingFreezeAmount,
  rollbackOrganizationFreeze,
} from './organization'
import { recordUsageCostOnly } from './reporting'
import type { ApiType, UsageUnit } from './cost'
import { getBillingMode } from './mode'
import { recordShadowCreditLedger } from './credit-ledger'
import { splitCreditPortions } from './credit-quota'
import { BillingOperationError, InsufficientBalanceError } from './errors'
import { roundMoney } from './money'
import { withTextUsageCollection, type TextUsageEntry } from './runtime-usage'
import type {
  BillingRecordParams,
  TaskBillingInfo,
} from './types'
import { BUILTIN_PRICING_VERSION } from '@/lib/model-pricing/version'
import { assertOrganizationCanConsume } from '@/lib/saas/entitlements'

type CostInput = {
  apiType: ApiType
  model: string
  quantity: number
  unit: UsageUnit
  metadata?: Record<string, unknown>
  quotedCost?: number
  maxCost?: number
  customPricing?: ModelCustomPricing | null
}

type SyncBillingParams<T> = {
  userId: string
  projectId: string
  action: string
  apiType: ApiType
  model: string
  quantity: number
  unit: UsageUnit
  metadata?: Record<string, unknown>
  quotedCost?: number
  maxCost?: number
  customPricing?: ModelCustomPricing | null
  extractActualQuantity?: (result: T) => number | null | undefined
}

type ResolvedActual = {
  actualCost: number
  actualQuantity: number
  metadata?: Record<string, unknown>
}

type UsageByModel = Record<string, { inputTokens: number; outputTokens: number; cost: number }>

const MONEY_SCALE = 6
const MONEY_EPSILON = 1e-9

function normalizeMoney(value: number): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return roundMoney(Math.max(0, numeric), MONEY_SCALE)
}

function asNumber(value: unknown): number | null {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return n
}

function resolveCost(input: CostInput) {
  const asMoney = (value: number) => normalizeMoney(value)

  if (typeof input.maxCost === 'number' && input.maxCost >= 0) {
    return asMoney(input.maxCost)
  }

  if (typeof input.quotedCost === 'number' && input.quotedCost >= 0) {
    return asMoney(input.quotedCost)
  }

  switch (input.apiType) {
    case 'text': {
      const inputTokens = Number(input.metadata?.inputTokens ?? Math.floor(input.quantity * 0.7))
      const outputTokens = Number(input.metadata?.outputTokens ?? Math.max(input.quantity - inputTokens, 0))
      return asMoney(calcText(input.model, Math.max(inputTokens, 0), Math.max(outputTokens, 0), input.customPricing))
    }
    case 'image':
      return asMoney(calcImage(input.model, input.quantity, input.metadata, input.customPricing))
    case 'video': {
      const resolution = typeof input.metadata?.resolution === 'string' ? input.metadata.resolution : '720p'
      return asMoney(calcVideo(input.model, resolution, input.quantity, input.metadata, input.customPricing))
    }
    case 'voice':
      return asMoney(calcVoice(input.quantity))
    case 'voice-design':
      return asMoney(calcVoiceDesign())
    case 'lip-sync':
      return asMoney(calcLipSync(input.model))
    default:
      throw new BillingOperationError('BILLING_INVALID_API_TYPE', `Unsupported billing apiType: ${String(input.apiType)}`, {
        apiType: input.apiType,
        model: input.model,
      })
  }
}

function resolveTextCostFromUsage(
  usage: TextUsageEntry[],
  customPricing?: ModelCustomPricing | null,
): ResolvedActual | null {
  if (!Array.isArray(usage) || usage.length === 0) return null

  let inputTokens = 0
  let outputTokens = 0
  let cost = 0
  const byModel: UsageByModel = {}

  for (const item of usage) {
    const inTokens = Math.max(0, Math.floor(Number(item.inputTokens || 0)))
    const outTokens = Math.max(0, Math.floor(Number(item.outputTokens || 0)))
    const model = item.model || 'unknown'
    const hasBillableTokens = inTokens > 0 || outTokens > 0
    const itemCost = hasBillableTokens ? normalizeMoney(calcText(model, inTokens, outTokens, customPricing)) : 0

    inputTokens += inTokens
    outputTokens += outTokens
    cost += itemCost

    if (!byModel[model]) {
      byModel[model] = { inputTokens: 0, outputTokens: 0, cost: 0 }
    }
    byModel[model].inputTokens += inTokens
    byModel[model].outputTokens += outTokens
    byModel[model].cost += itemCost
  }

  return {
    actualCost: normalizeMoney(cost),
    actualQuantity: inputTokens + outputTokens,
    metadata: {
      actualInputTokens: inputTokens,
      actualOutputTokens: outputTokens,
      usageByModel: byModel,
    },
  }
}

function resolveRecordModel(defaultModel: string, metadata?: Record<string, unknown>) {
  const usageByModelValue = metadata?.usageByModel
  if (!usageByModelValue || typeof usageByModelValue !== 'object' || Array.isArray(usageByModelValue)) {
    return {
      model: defaultModel,
      actualModels: [] as string[],
    }
  }
  const actualModels = Object.keys(usageByModelValue as UsageByModel).filter((item) => typeof item === 'string' && item.trim())
  if (actualModels.length === 0) {
    return {
      model: defaultModel,
      actualModels,
    }
  }
  if (actualModels.length === 1) {
    return {
      model: actualModels[0],
      actualModels,
    }
  }
  return {
    model: 'multi-model',
    actualModels,
  }
}

async function executeWithUsage<T>(
  apiType: ApiType,
  execute: () => Promise<T>,
): Promise<{ result: T; textUsage: TextUsageEntry[] }> {
  if (apiType !== 'text') {
    return {
      result: await execute(),
      textUsage: [],
    }
  }
  return await withTextUsageCollection(execute)
}

function clampChargedCost(actualCost: number, freezeCost: number) {
  const normalizedActual = normalizeMoney(actualCost)
  const normalizedFreeze = normalizeMoney(freezeCost)
  if (normalizedActual <= normalizedFreeze + MONEY_EPSILON) {
    return normalizedActual
  }
  _ulogError('[Billing] actual cost exceeds frozen max, overage freeze required', {
    actualCost: normalizedActual,
    frozenCost: normalizedFreeze,
    requiredOverage: normalizeMoney(normalizedActual - normalizedFreeze),
  })
  return normalizedActual
}

async function ensureFreezeCoverage(params: {
  freezeId: string
  userId: string
  actualCost: number
  quotedCost: number
}): Promise<number> {
  const normalizedQuoted = normalizeMoney(params.quotedCost)
  const chargedCost = clampChargedCost(params.actualCost, normalizedQuoted)
  if (chargedCost <= normalizedQuoted + MONEY_EPSILON) {
    return chargedCost
  }

  const overage = normalizeMoney(chargedCost - normalizedQuoted)
  if (overage <= MONEY_EPSILON) {
    return chargedCost
  }
  const expanded = await increasePendingFreezeAmount(params.freezeId, overage)
  if (expanded) {
    return chargedCost
  }

  await rollbackFreeze(params.freezeId)
  const balance = await getBalance(params.userId)
  throw new InsufficientBalanceError(chargedCost, balance.balance)
}

function resolveOrganizationChargeSplit(
  info: Extract<TaskBillingInfo, { billable: true }>,
  actualCost: number,
) {
  const normalizedActualCost = normalizeMoney(actualCost)
  const reservedPlanCredit = normalizeMoney(Number(info.planCreditApplied || 0))
  const planCreditAmount = Math.min(normalizedActualCost, reservedPlanCredit)
  const balanceAmount = normalizeMoney(Math.max(0, normalizedActualCost - planCreditAmount))
  return {
    planCreditAmount,
    balanceAmount,
  }
}

async function getOrganizationAvailableBalance(organizationId: string): Promise<number> {
  const balance = await getOrganizationBalance(organizationId)
  if (!balance) return 0
  return normalizeMoney(Number(balance.balance || 0) - Number(balance.frozenAmount || 0))
}

async function ensureOrganizationFreezeCoverage(params: {
  freezeId: string
  organizationId: string
  actualBalanceAmount: number
  quotedBalanceAmount: number
}): Promise<number> {
  const normalizedQuoted = normalizeMoney(params.quotedBalanceAmount)
  const chargedBalanceAmount = normalizeMoney(params.actualBalanceAmount)
  if (chargedBalanceAmount <= normalizedQuoted + MONEY_EPSILON) {
    return chargedBalanceAmount
  }

  const overage = normalizeMoney(chargedBalanceAmount - normalizedQuoted)
  if (overage <= MONEY_EPSILON) {
    return chargedBalanceAmount
  }

  const expanded = await increaseOrganizationPendingFreezeAmount(params.freezeId, overage)
  if (expanded) {
    return chargedBalanceAmount
  }

  await rollbackOrganizationFreeze(params.freezeId)
  const available = await getOrganizationAvailableBalance(params.organizationId)
  throw new InsufficientBalanceError(chargedBalanceAmount, available)
}

function resolveActualForSync<T>(
  params: SyncBillingParams<T>,
  result: T,
  textUsage: TextUsageEntry[],
  quotedCost: number,
): ResolvedActual {
  const textResolved = resolveTextCostFromUsage(textUsage, params.customPricing)
  if (params.apiType === 'text' && textResolved) {
    if (textResolved.actualQuantity > 0) {
      return textResolved
    }
    return {
      actualCost: quotedCost,
      actualQuantity: params.quantity,
      metadata: {
        ...(textResolved.metadata || {}),
      },
    }
  }

  if (params.extractActualQuantity) {
    const actualQuantity = asNumber(params.extractActualQuantity(result))
    if (actualQuantity !== null && actualQuantity >= 0) {
      return {
        actualCost: resolveCost({
          apiType: params.apiType,
          model: params.model,
          quantity: actualQuantity,
          unit: params.unit,
          metadata: params.metadata,
          customPricing: params.customPricing,
        }),
        actualQuantity,
      }
    }
  }

  return {
    actualCost: quotedCost,
    actualQuantity: params.quantity,
  }
}

function resolveTaskActual(
  info: Extract<TaskBillingInfo, { billable: true }>,
  quotedCost: number,
  options?: {
    result?: Record<string, unknown> | void
    textUsage?: TextUsageEntry[]
  },
  customPricing?: ModelCustomPricing | null,
): ResolvedActual {
  const textResolved = resolveTextCostFromUsage(options?.textUsage || [])
  if (info.apiType === 'text' && textResolved) {
    if (textResolved.actualQuantity > 0) {
      return textResolved
    }
    return {
      actualCost: quotedCost,
      actualQuantity: info.quantity,
      metadata: {
        ...(textResolved.metadata || {}),
      },
    }
  }

  const payload = options?.result && typeof options.result === 'object' ? options.result : null
  const actualVideoTokens = payload
    ? asNumber((payload as Record<string, unknown>).actualVideoTokens)
    : null
  if (info.apiType === 'video' && actualVideoTokens !== null && actualVideoTokens >= 0) {
    return {
      actualCost: calcVideoByTokens(info.model, actualVideoTokens, info.metadata, customPricing),
      actualQuantity: actualVideoTokens,
      metadata: {
        actualVideoTokens,
      },
    }
  }
  const actualQuantity = payload
    ? asNumber(
      (payload as Record<string, unknown>).actualQuantity
      ?? (payload as Record<string, unknown>).actualSeconds
      ?? (payload as Record<string, unknown>).actualDurationSeconds
      ?? (payload as Record<string, unknown>).actualCharacters
    )
    : null

  if (actualQuantity !== null && actualQuantity >= 0) {
    return {
      actualCost: resolveCost({
        apiType: info.apiType,
        model: info.model,
        quantity: actualQuantity,
        unit: info.unit,
        metadata: info.metadata,
        customPricing,
      }),
      actualQuantity,
    }
  }

  return {
    actualCost: resolveCost({
      apiType: info.apiType,
      model: info.model,
      quantity: info.quantity,
      unit: info.unit,
      metadata: info.metadata,
      quotedCost: info.maxFrozenCost,
      customPricing,
    }),
    actualQuantity: info.quantity,
  }
}

function buildSyncBillingKey<T>(params: SyncBillingParams<T>, recordParams: BillingRecordParams) {
  if (recordParams.billingKey) return recordParams.billingKey

  const metadataFingerprint = JSON.stringify({
    ...(recordParams.metadata || {}),
    ...(params.metadata || {}),
  })
  const requestId =
    recordParams.requestId
    || (typeof recordParams.metadata?.requestId === 'string' ? recordParams.metadata.requestId : null)
    || getLogContext().requestId

  if (requestId) {
    const digest = createHash('sha1')
      .update(`${params.userId}:${params.projectId}:${params.action}:${params.apiType}:${params.model}:${params.quantity}:${metadataFingerprint}:${requestId}`)
      .digest('hex')
      .slice(0, 16)
    return `sync_${requestId}_${digest}`
  }

  return `sync_${randomUUID()}`
}

async function withSyncBillingCore<T>(
  params: SyncBillingParams<T>,
  recordParams: BillingRecordParams,
  execute: () => Promise<T>,
): Promise<T> {
  const pricingVersion = BUILTIN_PRICING_VERSION
  const pricingSelections = params.metadata || {}
  const mode = await getBillingMode()
  if (mode === 'OFF') {
    return await execute()
  }

  const quotedCost = resolveCost({
    apiType: params.apiType,
    model: params.model,
    quantity: params.quantity,
    unit: params.unit,
    metadata: params.metadata,
    quotedCost: params.quotedCost,
    maxCost: params.maxCost,
    customPricing: params.customPricing,
  })

  if (quotedCost <= 0) {
    return await execute()
  }

  if (mode === 'SHADOW') {
    const { result, textUsage } = await executeWithUsage(params.apiType, execute)
    const actual = resolveActualForSync(params, result, textUsage, quotedCost)
    await recordShadowUsage(params.userId, {
      projectId: params.projectId,
      taskType: params.action || null,
      action: params.action,
      apiType: params.apiType,
      model: params.model,
      quantity: actual.actualQuantity,
      unit: params.unit,
      cost: actual.actualCost,
      metadata: {
        ...(recordParams.metadata || {}),
        ...(params.metadata || {}),
        ...(actual.metadata || {}),
        mode: 'SHADOW',
        quotedCost,
        pricingVersion,
        pricingSelections,
      },
    })
    return result
  }

  const billingKey = buildSyncBillingKey(params, recordParams)
  const requestId = recordParams.requestId || getLogContext().requestId || undefined
  const existingFreeze = await getFreezeByIdempotencyKey(billingKey)
  if (existingFreeze) {
    if (existingFreeze.status === 'confirmed') {
      throw new BillingOperationError(
        'BILLING_IDEMPOTENT_ALREADY_CONFIRMED',
        'duplicate billing request already confirmed',
        { billingKey, freezeId: existingFreeze.id },
      )
    }
    if (existingFreeze.status === 'pending') {
      throw new BillingOperationError(
        'BILLING_IDEMPOTENT_IN_PROGRESS',
        'duplicate billing request is already in progress',
        { billingKey, freezeId: existingFreeze.id },
      )
    }
    if (existingFreeze.status === 'rolled_back') {
      throw new BillingOperationError(
        'BILLING_IDEMPOTENT_ROLLED_BACK',
        'duplicate billing request was already rolled back',
        { billingKey, freezeId: existingFreeze.id },
      )
    }
  }

  const freezeId = await freezeBalance(params.userId, quotedCost, {
    source: 'sync',
    requestId,
    idempotencyKey: billingKey,
    metadata: {
      projectId: params.projectId,
      action: params.action,
      apiType: params.apiType,
      model: params.model,
      unit: params.unit,
      quantity: params.quantity,
      billingKey,
      requestId,
      ...(recordParams.metadata || {}),
      ...(params.metadata || {}),
      pricingVersion,
      pricingSelections,
    },
  })
  if (!freezeId) {
    const balance = await getBalance(params.userId)
    throw new InsufficientBalanceError(quotedCost, balance.balance)
  }

  try {
    const { result, textUsage } = await executeWithUsage(params.apiType, execute)
    const actual = resolveActualForSync(params, result, textUsage, quotedCost)
    const recordModel = resolveRecordModel(params.model, actual.metadata)
    const chargedCost = await ensureFreezeCoverage({
      freezeId,
      userId: params.userId,
      actualCost: actual.actualCost,
      quotedCost,
    })
    await confirmChargeWithRecord(
      freezeId,
      {
        projectId: params.projectId,
        action: params.action,
        apiType: params.apiType,
        model: recordModel.model,
        quantity: actual.actualQuantity,
        unit: params.unit,
        metadata: {
          ...(recordParams.metadata || {}),
          ...(params.metadata || {}),
          ...(actual.metadata || {}),
          mode: 'ENFORCE',
          quotedCost,
          actualCost: actual.actualCost,
          chargedCost,
          pricingVersion,
          pricingSelections,
          billingKey,
          requestId,
          ...(recordModel.actualModels.length > 0 ? { actualModels: recordModel.actualModels } : {}),
        },
      },
      { chargedAmount: chargedCost },
    )
    return result
  } catch (error) {
    await rollbackFreeze(freezeId)
    if (error instanceof BillingOperationError) {
      throw new BillingOperationError(error.code, error.message, {
        ...(error.details || {}),
        billingKey,
        pricingVersion,
      }, error)
    }
    throw error
  }
}

/**
 * Load user custom pricing for a specific model from their stored config.
 */
async function loadUserCustomPricing(
  userId: string,
  model: string,
): Promise<ModelCustomPricing | null> {
  const parsed = parseModelKeyStrict(model)
  if (!parsed) return null

  const pref = await prisma.userPreference.findUnique({
    where: { userId },
    select: { customModels: true },
  })
  if (!pref?.customModels) return null

  let models: Array<{ modelKey: string; customPricing?: unknown }>
  try {
    models = JSON.parse(pref.customModels) as typeof models
  } catch {
    return null
  }
  if (!Array.isArray(models)) return null

  const target = models.find((m) => m.modelKey === parsed.modelKey)
  const raw = target?.customPricing
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const pricing = raw as Record<string, unknown>

  const llmRaw = (pricing.llm && typeof pricing.llm === 'object' && !Array.isArray(pricing.llm))
    ? (pricing.llm as Record<string, unknown>)
    : pricing

  const inputPerMillion = typeof llmRaw.inputPerMillion === 'number'
    ? llmRaw.inputPerMillion
    : typeof pricing.input === 'number'
      ? pricing.input
      : undefined
  const outputPerMillion = typeof llmRaw.outputPerMillion === 'number'
    ? llmRaw.outputPerMillion
    : typeof pricing.output === 'number'
      ? pricing.output
      : undefined

  const normalizeMedia = (value: unknown): ModelCustomPricing['image'] | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    const basePrice = typeof record.basePrice === 'number' ? record.basePrice : undefined
    const rawOptions = record.optionPrices
    let optionPrices: Record<string, Record<string, number>> | undefined
    if (rawOptions && typeof rawOptions === 'object' && !Array.isArray(rawOptions)) {
      optionPrices = {}
      for (const [field, rawFieldOptions] of Object.entries(rawOptions as Record<string, unknown>)) {
        if (!rawFieldOptions || typeof rawFieldOptions !== 'object' || Array.isArray(rawFieldOptions)) continue
        const normalizedField: Record<string, number> = {}
        for (const [optionKey, rawAmount] of Object.entries(rawFieldOptions as Record<string, unknown>)) {
          if (typeof rawAmount !== 'number' || !Number.isFinite(rawAmount) || rawAmount < 0) continue
          normalizedField[optionKey] = rawAmount
        }
        if (Object.keys(normalizedField).length > 0) {
          optionPrices[field] = normalizedField
        }
      }
      if (Object.keys(optionPrices).length === 0) {
        optionPrices = undefined
      }
    }
    if (basePrice === undefined && optionPrices === undefined) return undefined
    return {
      ...(basePrice !== undefined ? { basePrice } : {}),
      ...(optionPrices ? { optionPrices } : {}),
    }
  }

  const image = normalizeMedia(pricing.image)
  const video = normalizeMedia(pricing.video)
  const llm = (typeof inputPerMillion === 'number' || typeof outputPerMillion === 'number')
    ? {
      ...(typeof inputPerMillion === 'number' ? { inputPerMillion } : {}),
      ...(typeof outputPerMillion === 'number' ? { outputPerMillion } : {}),
    }
    : undefined

  if (!llm && !image && !video) return null
  return {
    ...(llm ? { llm } : {}),
    ...(image ? { image } : {}),
    ...(video ? { video } : {}),
  }
}

export async function withTextBilling<T>(
  userId: string,
  model: string,
  maxInputTokens: number,
  maxOutputTokens: number,
  recordParams: BillingRecordParams,
  generateFn: () => Promise<T>,
): Promise<T> {
  const customPricing = await loadUserCustomPricing(userId, model)
  const quotedCost = calcText(model, maxInputTokens, maxOutputTokens, customPricing)
  return await withSyncBillingCore(
    {
      userId,
      projectId: recordParams.projectId,
      action: recordParams.action,
      apiType: 'text',
      model,
      quantity: maxInputTokens + maxOutputTokens,
      unit: 'token',
      metadata: {
        ...recordParams.metadata,
        maxInputTokens,
        maxOutputTokens,
      },
      maxCost: quotedCost,
      customPricing,
    },
    recordParams,
    generateFn,
  )
}

export async function withImageBilling<T>(
  userId: string,
  model: string,
  count: number,
  recordParams: BillingRecordParams,
  generateFn: () => Promise<T>,
): Promise<T> {
  const customPricing = await loadUserCustomPricing(userId, model)
  return await withSyncBillingCore(
    {
      userId,
      projectId: recordParams.projectId,
      action: recordParams.action,
      apiType: 'image',
      model,
      quantity: count,
      unit: 'image',
      metadata: recordParams.metadata,
      customPricing,
    },
    recordParams,
    generateFn,
  )
}

export async function withVideoBilling<T>(
  userId: string,
  model: string,
  resolution: string,
  maxCount: number,
  recordParams: BillingRecordParams,
  generateFn: () => Promise<T>,
): Promise<T> {
  const customPricing = await loadUserCustomPricing(userId, model)
  return await withSyncBillingCore(
    {
      userId,
      projectId: recordParams.projectId,
      action: recordParams.action,
      apiType: 'video',
      model,
      quantity: maxCount,
      unit: 'video',
      metadata: { ...recordParams.metadata, resolution },
      customPricing,
    },
    recordParams,
    generateFn,
  )
}

export async function withVoiceBilling<T>(
  userId: string,
  maxFreezeSeconds: number,
  recordParams: BillingRecordParams,
  generateFn: () => Promise<T>,
): Promise<T> {
  return await withSyncBillingCore(
    {
      userId,
      projectId: recordParams.projectId,
      action: recordParams.action,
      apiType: 'voice',
      model: 'index-tts2',
      quantity: maxFreezeSeconds,
      unit: 'second',
      metadata: recordParams.metadata,
      maxCost: calcVoice(maxFreezeSeconds),
      extractActualQuantity: (result) => {
        if (!result || typeof result !== 'object') return null
        const value =
          (result as Record<string, unknown>).actualDurationSeconds
          ?? (result as Record<string, unknown>).actualSeconds
        return asNumber(value)
      },
    },
    recordParams,
    generateFn,
  )
}

export async function withVoiceDesignBilling<T>(
  userId: string,
  recordParams: BillingRecordParams,
  generateFn: () => Promise<T>,
): Promise<T> {
  return await withSyncBillingCore(
    {
      userId,
      projectId: recordParams.projectId,
      action: recordParams.action,
      apiType: 'voice-design',
      model: 'bailian',
      quantity: 1,
      unit: 'call',
      metadata: recordParams.metadata,
    },
    recordParams,
    generateFn,
  )
}

export async function withLipSyncBilling<T>(
  userId: string,
  recordParams: BillingRecordParams,
  model = 'kling',
  generateFn: () => Promise<T>,
): Promise<T> {
  return await withSyncBillingCore(
    {
      userId,
      projectId: recordParams.projectId,
      action: recordParams.action,
      apiType: 'lip-sync',
      model,
      quantity: 1,
      unit: 'call',
      metadata: recordParams.metadata,
    },
    recordParams,
    generateFn,
  )
}

export function handleBillingError(error: unknown): NextResponse | null {
  if (error instanceof InsufficientBalanceError) {
    return NextResponse.json(
      {
        error: error.message,
        code: 'INSUFFICIENT_BALANCE',
        required: error.required,
        available: error.available,
      },
      { status: 402 },
    )
  }
  return null
}

export async function prepareTaskBilling(task: {
  id: string
  userId: string
  projectId: string
  organizationId?: string | null
  billingInfo: TaskBillingInfo | { billable: false } | null
}) {
  const info = task.billingInfo
  if (!info || !info.billable) return info

  const mode = await getBillingMode()
  const next: TaskBillingInfo = {
    ...info,
    modeSnapshot: mode,
    billingKey: info.billingKey || task.id,
    pricingVersion: info.pricingVersion || BUILTIN_PRICING_VERSION,
  }

  if (mode === 'OFF') {
    next.status = 'skipped'
    return next
  }

  const customPricing = await loadUserCustomPricing(task.userId, info.model)
  let quotedCost: number
  try {
    quotedCost = resolveCost({
      apiType: info.apiType,
      model: info.model,
      quantity: info.quantity,
      unit: info.unit,
      metadata: info.metadata,
      quotedCost: info.maxFrozenCost,
      customPricing,
    })
  } catch (error) {
    if (mode !== 'ENFORCE' && error instanceof BillingOperationError && error.code === 'BILLING_UNKNOWN_MODEL') {
      next.status = mode === 'SHADOW' ? 'quoted' : 'skipped'
      next.maxFrozenCost = 0
      return next
    }
    throw error
  }

  if (quotedCost <= 0) {
    next.status = 'skipped'
    return next
  }

  const organizationPolicy = await assertOrganizationCanConsume(task.userId, quotedCost, info.taskType, {
    organizationId: task.organizationId !== undefined ? task.organizationId : info.organizationId,
    projectId: task.projectId,
  })
  if (organizationPolicy) {
    next.organizationId = organizationPolicy.organizationId
    next.planCreditApplied = organizationPolicy.planCreditApplied
    next.balanceChargeApplied = organizationPolicy.balanceChargeApplied
    next.freezeScope = 'organization'
  }

  if (mode === 'SHADOW') {
    next.status = 'quoted'
    next.maxFrozenCost = quotedCost
    // Shadow ledger only. ENFORCE still freezes below and does not write this table.
    const quotedPortions = splitCreditPortions(quotedCost, next.planCreditApplied, next.balanceChargeApplied)
    await recordShadowCreditLedger({
      mode,
      phase: 'prepare',
      taskId: task.id,
      userId: task.userId,
      projectId: task.projectId,
      organizationId: next.organizationId ?? null,
      operationType: info.apiType,
      quantity: info.quantity,
      estimatedAmount: quotedCost,
      planCreditPortion: quotedPortions.planCreditPortion,
      balancePortion: quotedPortions.balancePortion,
    })
    return next
  }

  if (organizationPolicy) {
    const balanceCharge = normalizeMoney(Number(organizationPolicy.balanceChargeApplied || 0))
    const freezeId = await freezeOrganizationBalance(organizationPolicy.organizationId, balanceCharge, {
      userId: task.userId,
      taskId: task.id,
      idempotencyKey: info.billingKey || task.id,
      planCreditAmount: organizationPolicy.planCreditApplied,
      memberQuota: organizationPolicy.memberQuota,
      monthlyPlanCredit: organizationPolicy.monthlyPlanCredit,
      estimatedCost: quotedCost,
      description: `任务余额冻结：${info.action}`,
      metadata: {
        taskType: info.taskType,
        action: info.action,
        apiType: info.apiType,
        model: info.model,
        quantity: info.quantity,
        unit: info.unit,
        billingKey: info.billingKey || task.id,
        pricingVersion: info.pricingVersion || BUILTIN_PRICING_VERSION,
        pricingSelections: info.metadata || {},
        planCreditApplied: organizationPolicy.planCreditApplied,
        balanceChargeApplied: balanceCharge,
        ...(info.metadata || {}),
      },
    })
    if (!freezeId) {
      if (balanceCharge <= MONEY_EPSILON) {
        throw new BillingOperationError('BILLING_CONFIRM_FAILED', 'create organization billing reservation failed', {
          taskId: task.id,
          organizationId: organizationPolicy.organizationId,
          billingKey: info.billingKey || task.id,
        })
      }
      const available = await getOrganizationAvailableBalance(organizationPolicy.organizationId)
      throw new InsufficientBalanceError(balanceCharge, available)
    }

    next.status = 'frozen'
    next.freezeId = freezeId
    next.maxFrozenCost = quotedCost
    return next
  }

  const freezeId = await freezeBalance(task.userId, quotedCost, {
    source: 'task',
    taskId: task.id,
    idempotencyKey: info.billingKey || task.id,
    metadata: {
      taskType: info.taskType,
      action: info.action,
      apiType: info.apiType,
      model: info.model,
      quantity: info.quantity,
      unit: info.unit,
      billingKey: info.billingKey || task.id,
      pricingVersion: info.pricingVersion || BUILTIN_PRICING_VERSION,
      pricingSelections: info.metadata || {},
      ...(info.metadata || {}),
    },
  })
  if (!freezeId) {
    const balance = await getBalance(task.userId)
    throw new InsufficientBalanceError(quotedCost, balance.balance)
  }

  next.status = 'frozen'
  next.freezeId = freezeId
  next.freezeScope = 'user'
  next.maxFrozenCost = quotedCost
  return next
}

export async function settleTaskBilling(task: {
  id: string
  projectId: string
  episodeId?: string | null
  userId: string
  billingInfo: TaskBillingInfo | { billable: false } | null
}, options?: {
  result?: Record<string, unknown> | void
  textUsage?: TextUsageEntry[]
}) {
  const info = task.billingInfo
  if (!info || !info.billable) return info

  const mode = info.modeSnapshot || await getBillingMode()
  const noChargeStatus = info.status === 'skipped' ? 'skipped' : 'settled'
  if (mode === 'OFF') {
    return {
      ...info,
      modeSnapshot: mode,
      status: noChargeStatus,
      chargedCost: 0,
    } satisfies TaskBillingInfo
  }

  const customPricing = await loadUserCustomPricing(task.userId, info.model)
  let quotedCost: number
  try {
    quotedCost = resolveCost({
      apiType: info.apiType,
      model: info.model,
      quantity: info.quantity,
      unit: info.unit,
      metadata: info.metadata,
      quotedCost: info.maxFrozenCost,
      customPricing,
    })
  } catch (error) {
    if (mode === 'SHADOW' && error instanceof BillingOperationError && error.code === 'BILLING_UNKNOWN_MODEL') {
      return {
        ...info,
        modeSnapshot: mode,
        status: noChargeStatus,
        chargedCost: 0,
      } satisfies TaskBillingInfo
    }
    throw error
  }

  if (mode === 'SHADOW' && quotedCost <= 0) {
    return {
      ...info,
      modeSnapshot: mode,
      status: noChargeStatus,
      chargedCost: 0,
    } satisfies TaskBillingInfo
  }

  let actual: ResolvedActual
  try {
    actual = resolveTaskActual(info, quotedCost, options, customPricing)
  } catch (error) {
    if (mode === 'SHADOW' && error instanceof BillingOperationError && error.code === 'BILLING_UNKNOWN_MODEL') {
      return {
        ...info,
        modeSnapshot: mode,
        status: noChargeStatus,
        chargedCost: 0,
      } satisfies TaskBillingInfo
    }
    throw error
  }

  if (mode === 'SHADOW') {
    const settledPortions = splitCreditPortions(actual.actualCost, info.planCreditApplied, info.balanceChargeApplied)
    await recordShadowUsage(task.userId, {
      projectId: task.projectId,
      episodeId: typeof task.episodeId === 'string' ? task.episodeId : null,
      taskType: info.taskType || null,
        organizationId: info.organizationId || null,
        planCreditAmount: settledPortions.planCreditPortion,
        balanceAmount: settledPortions.balancePortion,
      action: info.action,
      apiType: info.apiType,
      model: info.model,
      quantity: actual.actualQuantity,
      unit: info.unit,
      cost: actual.actualCost,
      metadata: {
        ...(info.metadata || {}),
        ...(actual.metadata || {}),
        mode: 'SHADOW',
        taskId: task.id,
        taskType: info.taskType,
        quotedCost,
        pricingVersion: info.pricingVersion || BUILTIN_PRICING_VERSION,
        pricingSelections: info.metadata || {},
      },
    })
    await recordShadowCreditLedger({
      mode: 'SHADOW',
      phase: 'settle',
      taskId: task.id,
      userId: task.userId,
      projectId: task.projectId,
      organizationId: info.organizationId ?? null,
      operationType: info.apiType,
      quantity: actual.actualQuantity,
      estimatedAmount: quotedCost,
      actualAmount: actual.actualCost,
      planCreditPortion: settledPortions.planCreditPortion,
      balancePortion: settledPortions.balancePortion,
    })
    return {
      ...info,
      modeSnapshot: mode,
      status: info.status === 'skipped' ? 'skipped' : 'settled',
      chargedCost: 0,
    } satisfies TaskBillingInfo
  }

  if (mode !== 'ENFORCE') {
    return {
      ...info,
      modeSnapshot: mode,
      status: info.status === 'skipped' ? 'skipped' : 'settled',
      chargedCost: 0,
    } satisfies TaskBillingInfo
  }

  if (info.freezeScope === 'organization' || info.organizationId) {
    const organizationId = info.organizationId
    if (!organizationId) {
      return {
        ...info,
        status: 'failed',
      } satisfies TaskBillingInfo
    }

    const recordModel = resolveRecordModel(info.model, actual.metadata)
    const split = resolveOrganizationChargeSplit(info, actual.actualCost)
    if (!info.freezeId && actual.actualCost > MONEY_EPSILON) {
      throw new BillingOperationError('BILLING_CONFIRM_FAILED', 'organization task billing reservation is missing', {
        taskId: task.id,
        organizationId,
      })
    }

    const chargedBalanceAmount = info.freezeId
      ? await ensureOrganizationFreezeCoverage({
        freezeId: info.freezeId,
        organizationId,
        actualBalanceAmount: split.balanceAmount,
        quotedBalanceAmount: info.balanceChargeApplied || 0,
      })
      : 0

    try {
      const commonRecordParams = {
        projectId: task.projectId,
        userId: task.userId,
        action: info.action,
        apiType: info.apiType,
        model: recordModel.model,
        quantity: actual.actualQuantity,
        unit: info.unit,
        cost: actual.actualCost,
        balanceAfter: 0,
        freezeId: info.freezeId || undefined,
        episodeId: typeof task.episodeId === 'string' ? task.episodeId : null,
        taskType: info.taskType || null,
        organizationId,
        planCreditAmount: split.planCreditAmount,
        balanceAmount: chargedBalanceAmount,
        metadata: {
          ...(info.metadata || {}),
          ...(actual.metadata || {}),
          billingKey: info.billingKey || task.id,
          source: 'task',
          taskType: info.taskType,
          taskId: task.id,
          mode: 'ENFORCE',
          quotedCost,
          actualCost: actual.actualCost,
          chargedCost: actual.actualCost,
          organizationChargedBalanceAmount: chargedBalanceAmount,
          pricingVersion: info.pricingVersion || BUILTIN_PRICING_VERSION,
          pricingSelections: info.metadata || {},
          ...(recordModel.actualModels.length > 0 ? { actualModels: recordModel.actualModels } : {}),
        },
      }

      if (info.freezeId) {
        const confirmed = await confirmOrganizationChargeWithRecord(
          info.freezeId,
          chargedBalanceAmount,
          commonRecordParams,
        )
        if (!confirmed) {
          throw new BillingOperationError('BILLING_CONFIRM_FAILED', 'confirm organization task charge failed', {
            taskId: task.id,
            freezeId: info.freezeId,
            organizationId,
          })
        }
      } else {
        await recordUsageCostOnly(prisma, {
          ...commonRecordParams,
          metadata: {
            ...commonRecordParams.metadata,
            organizationBalanceSettled: true,
            skipUserBalanceTransaction: true,
          },
        })
      }
    } catch (error) {
      const rolledBack = (await rollbackTaskBilling({
        id: task.id,
        billingInfo: info,
      })) as TaskBillingInfo
      if (rolledBack.billable && rolledBack.status !== 'rolled_back' && info.freezeId) {
        throw new BillingOperationError('BILLING_CONFIRM_FAILED', 'confirm organization task charge failed; billing rollback failed', {
          taskId: task.id,
          freezeId: info.freezeId,
          organizationId,
        }, error)
      }
      if (error instanceof BillingOperationError) {
        throw new BillingOperationError(error.code, error.message, {
          ...(error.details || {}),
          taskId: task.id,
          freezeId: info.freezeId || null,
          organizationId,
        }, error)
      }
      throw error
    }

    return {
      ...info,
      status: 'settled',
      chargedCost: actual.actualCost,
      planCreditApplied: split.planCreditAmount,
      balanceChargeApplied: chargedBalanceAmount,
    } satisfies TaskBillingInfo
  }

  if (!info.freezeId) {
    return {
      ...info,
      status: 'failed',
    } satisfies TaskBillingInfo
  }

  const chargedCost = await ensureFreezeCoverage({
    freezeId: info.freezeId,
    userId: task.userId,
    actualCost: actual.actualCost,
    quotedCost,
  })
  const recordModel = resolveRecordModel(info.model, actual.metadata)
  try {
    await confirmChargeWithRecord(
      info.freezeId,
      {
        projectId: task.projectId,
        action: info.action,
        apiType: info.apiType,
        model: recordModel.model,
        quantity: actual.actualQuantity,
        unit: info.unit,
        metadata: {
          ...(info.metadata || {}),
          ...(actual.metadata || {}),
          billingKey: info.billingKey || task.id,
          source: 'task',
          taskType: info.taskType,
          taskId: task.id,
          mode: 'ENFORCE',
          quotedCost,
          actualCost: actual.actualCost,
          chargedCost,
          pricingVersion: info.pricingVersion || BUILTIN_PRICING_VERSION,
          pricingSelections: info.metadata || {},
          ...(recordModel.actualModels.length > 0 ? { actualModels: recordModel.actualModels } : {}),
        },
      },
      { chargedAmount: chargedCost },
    )
  } catch (error) {
    const rolledBack = (await rollbackTaskBilling({
      id: task.id,
      billingInfo: info,
    })) as TaskBillingInfo
    if (rolledBack.billable && rolledBack.status !== 'rolled_back') {
      throw new BillingOperationError('BILLING_CONFIRM_FAILED', 'confirm task charge failed; billing rollback failed', {
        taskId: task.id,
        freezeId: info.freezeId,
      }, error)
    }
    if (error instanceof BillingOperationError) {
      throw new BillingOperationError(error.code, error.message, {
        ...(error.details || {}),
        taskId: task.id,
        freezeId: info.freezeId,
      }, error)
    }
    throw error
  }

  return {
    ...info,
    status: 'settled',
    chargedCost,
  } satisfies TaskBillingInfo
}

export async function rollbackTaskBilling(task: {
  id: string
  billingInfo: TaskBillingInfo | { billable: false } | null
}) {
  const info = task.billingInfo
  if (!info || !info.billable) return info
  if (info.modeSnapshot === 'SHADOW') {
    await recordShadowCreditLedger({
      mode: 'SHADOW',
      phase: 'rollback',
      taskId: task.id,
      organizationId: info.organizationId ?? null,
      operationType: info.apiType,
      quantity: info.quantity,
      estimatedAmount: info.maxFrozenCost,
    })
    return info
  }
  if (!info.freezeId) return info
  if (info.modeSnapshot !== 'ENFORCE') return info

  try {
    const rolledBack = info.freezeScope === 'organization' || info.organizationId
      ? await rollbackOrganizationFreeze(info.freezeId)
      : await rollbackFreeze(info.freezeId)
    if (!rolledBack) {
      return {
        ...info,
        status: 'failed',
      } satisfies TaskBillingInfo
    }
    return {
      ...info,
      status: 'rolled_back',
    } satisfies TaskBillingInfo
  } catch (error) {
    _ulogError('[Billing] rollback task freeze failed:', error)
    return {
      ...info,
      status: 'failed',
    } satisfies TaskBillingInfo
  }
}
