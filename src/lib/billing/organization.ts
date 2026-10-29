/**
 * 组织计费逻辑
 * 处理组织余额、成员配额和组织消费记录
 */

import { logInfo as _ulogInfo, logError as _ulogError } from '@/lib/logging/core'
import { prisma } from '@/lib/prisma'
import { toMoneyNumber, roundMoney, type MoneyValue } from './money'
import type { Prisma } from '@prisma/client'
import { recordUsageCostOnly } from './reporting'
import type { ApiType, UsageUnit } from './cost'
import { BillingOperationError } from './errors'
import { calendarMonthStart, evaluateMemberQuota, frozenHoldAmount, readStoredQuota, type MemberQuotaSnapshot } from './credit-quota'

const MONEY_SCALE = 6

function normalizeMoney(value: number): number {
  return roundMoney(value, MONEY_SCALE)
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function isPendingFreezeUsage(usage: { type: string; metadata: Prisma.JsonValue | null }): boolean {
  const metadata = readRecord(usage.metadata)
  return usage.type === 'freeze' && metadata.status === 'pending'
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'P2002',
  )
}

type OrganizationBalanceSnapshot = {
  id: string
  organizationId: string
  balance: number
  frozenAmount: number
  totalSpent: number
  createdAt: Date
  updatedAt: Date
}

type OrganizationMemberSnapshot = {
  id: string
  userId: string
  organizationId: string
  role: string
  quota: number
  status: string
  joinedAt: Date
}

function toBalanceSnapshot(balance: {
  id: string
  organizationId: string
  balance: MoneyValue
  frozenAmount: MoneyValue
  totalSpent: MoneyValue
  createdAt: Date
  updatedAt: Date
}): OrganizationBalanceSnapshot {
  return {
    id: balance.id,
    organizationId: balance.organizationId,
    balance: toMoneyNumber(balance.balance),
    frozenAmount: toMoneyNumber(balance.frozenAmount),
    totalSpent: toMoneyNumber(balance.totalSpent),
    createdAt: balance.createdAt,
    updatedAt: balance.updatedAt,
  }
}

type OrganizationBalanceRecord = Parameters<typeof toBalanceSnapshot>[0]
type OrganizationBillingClient = Pick<Prisma.TransactionClient, 'organizationBalance' | 'organizationUsage'>

type OrganizationUsageRecordParams = {
  projectId: string
  userId: string
  action: string
  apiType: ApiType
  model: string
  quantity: number
  unit: UsageUnit
  cost: number
  balanceAfter: number
  freezeId?: string
  episodeId?: string | null
  taskType?: string | null
  organizationId?: string | null
  planCreditAmount?: number
  balanceAmount?: number
  metadata?: Record<string, unknown>
}

/**
 * 获取组织余额
 */
export async function getOrganizationBalance(organizationId: string): Promise<OrganizationBalanceSnapshot | null> {
  const balance = await prisma.organizationBalance.findUnique({
    where: { organizationId },
  })

  if (!balance) {
    return null
  }

  return toBalanceSnapshot(balance)
}

/**
 * 确保组织有余额记录（如果不存在则创建）
 */
export async function ensureOrganizationBalance(organizationId: string): Promise<OrganizationBalanceSnapshot> {
  let balance = await prisma.organizationBalance.findUnique({
    where: { organizationId },
  })

  if (!balance) {
    balance = await prisma.organizationBalance.create({
      data: {
        organizationId,
        balance: 0,
        frozenAmount: 0,
        totalSpent: 0,
      },
    })
  }

  return toBalanceSnapshot(balance)
}

async function ensureOrganizationBalanceWithClient(
  client: OrganizationBillingClient,
  organizationId: string,
): Promise<OrganizationBalanceRecord> {
  let balance = await client.organizationBalance.findUnique({
    where: { organizationId },
  })

  if (!balance) {
    balance = await client.organizationBalance.create({
      data: {
        organizationId,
        balance: 0,
        frozenAmount: 0,
        totalSpent: 0,
      },
    })
  }

  return balance
}

async function addOrganizationBalanceWithClient(
  client: OrganizationBillingClient,
  organizationId: string,
  amount: number,
  options?: {
    reason?: string
    operatorId?: string
    externalOrderId?: string
    idempotencyKey?: string
  },
): Promise<OrganizationBalanceRecord> {
  const normalizedAmount = normalizeMoney(Number(amount))
  if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
    throw new Error('amount must be a positive number')
  }

  const idempotencyKey = options?.idempotencyKey?.trim()

  if (idempotencyKey) {
    const existingRecharge = await client.organizationUsage.findFirst({
      where: {
        organizationId,
        type: 'recharge',
        idempotencyKey,
      },
    })
    if (existingRecharge) {
      return ensureOrganizationBalanceWithClient(client, organizationId)
    }
  }

  await client.organizationUsage.create({
    data: {
      organizationId,
      userId: options?.operatorId || 'system',
      amount: normalizedAmount,
      balanceAmount: normalizedAmount,
      type: 'recharge',
      orderId: options?.externalOrderId || null,
      idempotencyKey: idempotencyKey || null,
      description: options?.reason || '组织余额充值',
      metadata: {
        externalOrderId: options?.externalOrderId || null,
      },
    },
  })

  let balance = await client.organizationBalance.findUnique({
    where: { organizationId },
  })

  if (!balance) {
    balance = await client.organizationBalance.create({
      data: {
        organizationId,
        balance: normalizedAmount,
        frozenAmount: 0,
        totalSpent: 0,
      },
    })
  } else {
    balance = await client.organizationBalance.update({
      where: { organizationId },
      data: {
        balance: { increment: normalizedAmount },
      },
    })
  }

  return balance
}

/**
 * 增加组织余额
 */
export async function addOrganizationBalance(
  organizationId: string,
  amount: number,
  options?: {
    reason?: string
    operatorId?: string
    externalOrderId?: string
    idempotencyKey?: string
  },
): Promise<OrganizationBalanceSnapshot> {
  const idempotencyKey = options?.idempotencyKey?.trim()
  let updatedBalance: OrganizationBalanceRecord
  try {
    updatedBalance = await prisma.$transaction(async (tx) => {
      return addOrganizationBalanceWithClient(tx, organizationId, amount, options)
    })
  } catch (error) {
    if (idempotencyKey && isUniqueConstraintError(error)) {
      return ensureOrganizationBalance(organizationId)
    }
    throw error
  }

  _ulogInfo(`[OrganizationBalance] add balance success: organizationId=${organizationId}, amount=¥${normalizeMoney(Number(amount))}, reason=${options?.reason || 'N/A'}`)

  return toBalanceSnapshot(updatedBalance)
}

export async function addOrganizationBalanceInTransaction(
  tx: Prisma.TransactionClient,
  organizationId: string,
  amount: number,
  options?: {
    reason?: string
    operatorId?: string
    externalOrderId?: string
    idempotencyKey?: string
  },
): Promise<OrganizationBalanceSnapshot> {
  const idempotencyKey = options?.idempotencyKey?.trim()
  try {
    return toBalanceSnapshot(await addOrganizationBalanceWithClient(tx, organizationId, amount, options))
  } catch (error) {
    if (idempotencyKey && isUniqueConstraintError(error)) {
      return toBalanceSnapshot(await ensureOrganizationBalanceWithClient(tx, organizationId))
    }
    throw error
  }
}

/**
 * 冻结组织余额（用于预付费场景）
 */
export async function freezeOrganizationBalance(
  organizationId: string,
  amount: number,
  options?: {
    userId?: string
    taskId?: string
    idempotencyKey?: string
    planCreditAmount?: number
    memberQuota?: number
    monthlyPlanCredit?: number
    estimatedCost?: number
    description?: string
    metadata?: Record<string, unknown>
  },
): Promise<string | null> {
  const normalizedAmount = normalizeMoney(Number(amount))
  const normalizedPlanCredit = normalizeMoney(Number(options?.planCreditAmount || 0))
  if (
    !Number.isFinite(normalizedAmount)
    || !Number.isFinite(normalizedPlanCredit)
    || normalizedAmount < 0
    || normalizedPlanCredit < 0
    || (normalizedAmount <= 0 && normalizedPlanCredit <= 0)
  ) {
    return null
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const idempotencyKey = options?.idempotencyKey?.trim()
      if (idempotencyKey) {
        const existing = await tx.organizationUsage.findFirst({
          where: {
            organizationId,
            idempotencyKey,
          },
          select: { id: true, amount: true, planCreditAmount: true, taskId: true, type: true, metadata: true },
        })
        if (
          existing?.id
          && isPendingFreezeUsage(existing)
          && normalizeMoney(toMoneyNumber(existing.amount)) === normalizedAmount
          && normalizeMoney(toMoneyNumber(existing.planCreditAmount)) === normalizedPlanCredit
          && (!options?.taskId || existing.taskId === options.taskId)
        ) {
          return existing.id
        }
        if (existing?.id) return null
      }

      if (typeof tx.$queryRaw === 'function') {
        await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${organizationId} FOR UPDATE`
      }

      const monthStart = new Date()
      monthStart.setDate(1)
      monthStart.setHours(0, 0, 0, 0)
      const estimatedCost = normalizeMoney(Number(options?.estimatedCost || normalizedAmount + normalizedPlanCredit))
      // Legacy: quota 0 is unlimited here because the value is falsy. 0 = forbidden is not wired yet.
      if (options?.memberQuota && options.userId) {
        const memberUsage = await tx.organizationUsage.aggregate({
          where: {
            organizationId,
            userId: options.userId,
            createdAt: { gte: monthStart },
            OR: [
              { type: 'task' },
              { type: 'freeze', metadata: { path: '$.status', equals: 'pending' } },
            ],
          },
          _sum: { planCreditAmount: true, balanceAmount: true },
        })
        const used = normalizeMoney(toMoneyNumber(memberUsage._sum.planCreditAmount) + toMoneyNumber(memberUsage._sum.balanceAmount))
        if (used + estimatedCost > options.memberQuota) return null
      }
      if (options?.monthlyPlanCredit !== undefined) {
        const planUsage = await tx.organizationUsage.aggregate({
          where: {
            organizationId,
            createdAt: { gte: monthStart },
            OR: [
              { type: 'task' },
              { type: 'freeze', metadata: { path: '$.status', equals: 'pending' } },
            ],
          },
          _sum: { planCreditAmount: true },
        })
        const used = normalizeMoney(toMoneyNumber(planUsage._sum.planCreditAmount))
        if (used + normalizedPlanCredit > options.monthlyPlanCredit) return null
      }

      // 确保余额记录存在
      let balance = await tx.organizationBalance.findUnique({
        where: { organizationId },
      })

      if (!balance) {
        balance = await tx.organizationBalance.create({
          data: {
            organizationId,
            balance: 0,
            frozenAmount: 0,
            totalSpent: 0,
          },
        })
      }

      if (normalizedAmount > 0) {
        // 尝试扣减余额并增加冻结金额
        const updated = await tx.organizationBalance.updateMany({
          where: {
            organizationId,
            balance: { gte: normalizedAmount },
          },
          data: {
            balance: { decrement: normalizedAmount },
            frozenAmount: { increment: normalizedAmount },
          },
        })

        if (updated.count === 0) {
          return null
        }
      }

      const freeze = await tx.organizationUsage.create({
        data: {
          organizationId,
          userId: options?.userId || 'system',
          amount: normalizedAmount,
          planCreditAmount: normalizedPlanCredit,
          balanceAmount: normalizedAmount,
          type: 'freeze',
          taskId: options?.taskId || null,
          idempotencyKey: idempotencyKey || null,
          description: options?.description || '组织余额冻结',
          metadata: {
            ...(options?.metadata || {}),
            status: 'pending',
            freezeAmount: normalizedAmount,
          },
        },
      })

      return freeze.id
    })

    return result
  } catch (error) {
    if (options?.idempotencyKey && isUniqueConstraintError(error)) {
      const existing = await prisma.organizationUsage.findFirst({
        where: {
          organizationId,
          idempotencyKey: options.idempotencyKey.trim(),
        },
        select: { id: true, amount: true, planCreditAmount: true, taskId: true, type: true, metadata: true },
      })
      if (
        existing?.id
        && isPendingFreezeUsage(existing)
        && normalizeMoney(toMoneyNumber(existing.amount)) === normalizedAmount
        && normalizeMoney(toMoneyNumber(existing.planCreditAmount)) === normalizedPlanCredit
        && (!options?.taskId || existing.taskId === options.taskId)
      ) {
        return existing.id
      }
    }
    _ulogError('[OrganizationBilling] freeze failed:', error)
    return null
  }
}

export async function increaseOrganizationPendingFreezeAmount(
  freezeId: string,
  delta: number,
): Promise<boolean> {
  const normalizedDelta = normalizeMoney(Number(delta))
  if (!Number.isFinite(normalizedDelta) || normalizedDelta < 0) {
    return false
  }
  if (normalizedDelta === 0) {
    return true
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const freeze = await tx.organizationUsage.findUnique({
        where: { id: freezeId },
      })
      if (!freeze) return false
      if (freeze.type === 'charge' && readRecord(freeze.metadata).status === 'confirmed') return true
      if (!isPendingFreezeUsage(freeze)) return false

      const updated = await tx.organizationBalance.updateMany({
        where: {
          organizationId: freeze.organizationId,
          balance: { gte: normalizedDelta },
        },
        data: {
          balance: { decrement: normalizedDelta },
          frozenAmount: { increment: normalizedDelta },
        },
      })
      if (updated.count === 0) {
        return false
      }

      const metadata = readRecord(freeze.metadata)
      const currentFreezeAmount = normalizeMoney(toMoneyNumber(freeze.amount))
      const nextFreezeAmount = normalizeMoney(currentFreezeAmount + normalizedDelta)
      const claimed = await tx.organizationUsage.updateMany({
        where: {
          id: freeze.id,
          type: 'freeze',
        },
        data: {
          amount: { increment: normalizedDelta },
          balanceAmount: { increment: normalizedDelta },
          metadata: {
            ...metadata,
            status: 'pending',
            freezeAmount: nextFreezeAmount,
          },
        },
      })
      if (claimed.count === 0) {
        throw new Error(`Unable to expand organization freeze ${freeze.id}`)
      }
      return true
    })
  } catch (error) {
    _ulogError('[OrganizationBilling] increase pending freeze failed:', error)
    return false
  }
}

/**
 * 确认扣款（从冻结金额转为实际消费）
 */
export async function confirmOrganizationCharge(
  freezeId: string,
  amount: number,
): Promise<boolean> {
  const normalizedAmount = normalizeMoney(Number(amount))
  if (!Number.isFinite(normalizedAmount) || normalizedAmount < 0) {
    return false
  }

  try {
    const confirmed = await prisma.$transaction(async (tx) => {
      const freeze = await tx.organizationUsage.findUnique({
        where: { id: freezeId },
      })
      if (!freeze) return false
      if (freeze.type === 'charge' && readRecord(freeze.metadata).status === 'confirmed') return true
      if (!isPendingFreezeUsage(freeze)) return false

      const frozenAmount = normalizeMoney(toMoneyNumber(freeze.amount))
      const chargedAmount = Math.min(normalizedAmount, frozenAmount)
      const refundAmount = normalizeMoney(Math.max(0, frozenAmount - chargedAmount))

      const claim = await tx.organizationUsage.updateMany({
        where: {
          id: freeze.id,
          type: 'freeze',
        },
        data: {
          type: 'freeze_confirming',
          metadata: {
            status: 'confirming',
            freezeAmount: frozenAmount,
            chargedAmount,
            refundedAmount: refundAmount,
          },
        },
      })
      if (claim.count === 0) return false

      const updated = await tx.organizationBalance.updateMany({
        where: {
          organizationId: freeze.organizationId,
          frozenAmount: { gte: frozenAmount },
        },
        data: {
          frozenAmount: { decrement: frozenAmount },
          totalSpent: { increment: chargedAmount },
          ...(refundAmount > 0 ? { balance: { increment: refundAmount } } : {}),
        },
      })
      if (updated.count === 0) {
        throw new Error(`Unable to confirm organization freeze ${freeze.id}`)
      }

      await tx.organizationUsage.update({
        where: { id: freeze.id },
        data: {
          amount: chargedAmount,
          balanceAmount: chargedAmount,
          type: 'charge',
          metadata: {
            status: 'confirmed',
            freezeAmount: frozenAmount,
            chargedAmount,
            refundedAmount: refundAmount,
          },
        },
      })

      return true
    })

    return confirmed
  } catch (error) {
    _ulogError('[OrganizationBilling] confirm charge failed:', error)
    return false
  }
}

export async function confirmOrganizationChargeWithRecord(
  freezeId: string,
  amount: number,
  recordParams: OrganizationUsageRecordParams,
): Promise<boolean> {
  const normalizedAmount = normalizeMoney(Number(amount))
  if (!Number.isFinite(normalizedAmount) || normalizedAmount < 0) {
    return false
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const freeze = await tx.organizationUsage.findUnique({
        where: { id: freezeId },
      })
      if (!freeze) return false
      if (freeze.type === 'charge' && readRecord(freeze.metadata).status === 'confirmed') return true
      if (!isPendingFreezeUsage(freeze)) return false

      const frozenAmount = normalizeMoney(toMoneyNumber(freeze.amount))
      const chargedAmount = Math.min(normalizedAmount, frozenAmount)
      const refundAmount = normalizeMoney(Math.max(0, frozenAmount - chargedAmount))

      const claim = await tx.organizationUsage.updateMany({
        where: {
          id: freeze.id,
          type: 'freeze',
        },
        data: {
          type: 'freeze_confirming',
          metadata: {
            ...readRecord(freeze.metadata),
            status: 'confirming',
            freezeAmount: frozenAmount,
            chargedAmount,
            refundedAmount: refundAmount,
          },
        },
      })
      if (claim.count === 0) return false

      const updated = await tx.organizationBalance.updateMany({
        where: {
          organizationId: freeze.organizationId,
          frozenAmount: { gte: frozenAmount },
        },
        data: {
          frozenAmount: { decrement: frozenAmount },
          totalSpent: { increment: chargedAmount },
          ...(refundAmount > 0 ? { balance: { increment: refundAmount } } : {}),
        },
      })
      if (updated.count === 0) {
        throw new Error(`Unable to confirm organization freeze ${freeze.id}`)
      }

      await tx.organizationUsage.update({
        where: { id: freeze.id },
        data: {
          amount: chargedAmount,
          balanceAmount: chargedAmount,
          type: 'charge',
          metadata: {
            ...readRecord(freeze.metadata),
            status: 'confirmed',
            freezeAmount: frozenAmount,
            chargedAmount,
            refundedAmount: refundAmount,
          },
        },
      })

      await recordUsageCostOnly(tx, {
        ...recordParams,
        organizationId: freeze.organizationId,
        balanceAmount: recordParams.balanceAmount ?? chargedAmount,
        freezeId,
        metadata: {
          ...(recordParams.metadata || {}),
          organizationFreezeId: freezeId,
          organizationBalanceSettled: true,
          skipUserBalanceTransaction: true,
        },
      })

      return true
    })
  } catch (error) {
    _ulogError('[OrganizationBilling] confirm charge with record failed:', error)
    if (error instanceof BillingOperationError) {
      throw error
    }
    return false
  }
}

/**
 * 回滚组织余额冻结
 */
export async function rollbackOrganizationFreeze(freezeId: string): Promise<boolean> {
  try {
    const rolledBack = await prisma.$transaction(async (tx) => {
      const freeze = await tx.organizationUsage.findUnique({
        where: { id: freezeId },
      })
      if (!freeze || !isPendingFreezeUsage(freeze)) return false

      const frozenAmount = normalizeMoney(toMoneyNumber(freeze.amount))
      const claim = await tx.organizationUsage.updateMany({
        where: {
          id: freeze.id,
          type: 'freeze',
        },
        data: {
          type: 'freeze_rolling_back',
          metadata: {
            status: 'rolling_back',
            freezeAmount: frozenAmount,
          },
        },
      })
      if (claim.count === 0) return false

      const updated = await tx.organizationBalance.updateMany({
        where: {
          organizationId: freeze.organizationId,
          frozenAmount: { gte: frozenAmount },
        },
        data: {
          balance: { increment: frozenAmount },
          frozenAmount: { decrement: frozenAmount },
        },
      })
      if (updated.count === 0) {
        throw new Error(`Unable to roll back organization freeze ${freeze.id}`)
      }

      await tx.organizationUsage.update({
        where: { id: freeze.id },
        data: {
          type: 'freeze_rollback',
          metadata: {
            status: 'rolled_back',
            freezeAmount: frozenAmount,
          },
        },
      })

      return true
    })

    return rolledBack
  } catch (error) {
    _ulogError('[OrganizationBilling] rollback freeze failed:', error)
    return false
  }
}

/**
 * 检查组织余额是否足够
 */
export async function checkOrganizationBalance(organizationId: string, requiredAmount: number): Promise<boolean> {
  const balance = await getOrganizationBalance(organizationId)
  if (!balance) return false
  return balance.balance >= requiredAmount
}

/**
 * 获取组织成员配额信息
 */
export async function getOrganizationMemberQuota(organizationId: string, userId: string): Promise<OrganizationMemberSnapshot | null> {
  const member = await prisma.organizationMember.findUnique({
    where: {
      organizationId_userId: {
        organizationId,
        userId,
      },
    },
  })

  if (!member) {
    return null
  }

  return {
    id: member.id,
    userId: member.userId,
    organizationId: member.organizationId,
    role: member.role,
    // Legacy reader: null and 0 both surface as 0. Cap decisions use checkMemberQuota.
    quota: toMoneyNumber(member.quota || 0),
    status: member.status,
    joinedAt: member.joinedAt,
  }
}

/**
 * Member cap for the period. null quota is unlimited and 0 is forbidden.
 * Used includes settled task rows and pending freezes. quotaUsed is not read.
 * The default window is the calendar month until period policy is decided.
 * Pass periodStart/periodEnd to line this up with a CreditAccount later.
 */
export async function checkMemberQuota(
  organizationId: string,
  userId: string,
  options?: { periodStart?: Date; periodEnd?: Date },
): Promise<MemberQuotaSnapshot> {
  const member = await prisma.organizationMember.findUnique({
    where: {
      organizationId_userId: {
        organizationId,
        userId,
      },
    },
  })

  if (!member) {
    return { hasQuota: false, quota: 0, used: 0, remaining: 0, frozen: 0 }
  }

  const periodStart = options?.periodStart ?? calendarMonthStart()
  const createdAt: { gte: Date; lte?: Date } = { gte: periodStart }
  if (options?.periodEnd) createdAt.lte = options.periodEnd
  const usageWhere = { organizationId, userId, createdAt }

  const [settled, frozen] = await Promise.all([
    prisma.organizationUsage.aggregate({
      where: { ...usageWhere, type: 'task' },
      _sum: { amount: true },
    }),
    prisma.organizationUsage.aggregate({
      where: {
        ...usageWhere,
        type: 'freeze',
        metadata: { path: '$.status', equals: 'pending' },
      },
      _sum: { amount: true, planCreditAmount: true, balanceAmount: true },
    }),
  ])

  return evaluateMemberQuota({
    quota: readStoredQuota(member.quota),
    settledAmount: toMoneyNumber(settled._sum.amount),
    frozenAmount: frozenHoldAmount(frozen._sum),
  })
}

/**
 * 记录组织消费
 */
export async function recordOrganizationUsage(
  organizationId: string,
  userId: string,
  amount: number,
  type: string,
  description?: string,
): Promise<boolean> {
  try {
    const normalizedAmount = normalizeMoney(Number(amount))
    if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
      return false
    }

    await prisma.$transaction(async (tx) => {
      // 更新组织余额（消费）
      await tx.organizationBalance.update({
        where: { organizationId },
        data: {
          totalSpent: { increment: normalizedAmount },
        },
      })

      // 记录消费明细
      await tx.organizationUsage.create({
        data: {
          organizationId,
          userId,
          amount: normalizedAmount,
          type,
          description,
        },
      })
    })

    return true
  } catch (error) {
    _ulogError('[OrganizationBilling] record usage failed:', error)
    return false
  }
}

/**
 * 获取组织消费记录
 */
export async function getOrganizationUsage(
  organizationId: string,
  options?: {
    startDate?: Date
    endDate?: Date
  },
) {
  const where: Record<string, unknown> = {
    organizationId,
    type: 'task',
  }

  if (options?.startDate) {
    where.createdAt = { ...where.createdAt as object, gte: options.startDate }
  }

  if (options?.endDate) {
    where.createdAt = { ...where.createdAt as object, lte: options.endDate }
  }

  const usages = await prisma.organizationUsage.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  // 汇总统计
  const stats = await prisma.organizationUsage.aggregate({
    where,
    _sum: {
      amount: true,
    },
    _count: true,
  })

  return {
    usages: usages.map((u) => ({
      id: u.id,
      userId: u.userId,
      amount: toMoneyNumber(u.amount),
      type: u.type,
      description: u.description,
      createdAt: u.createdAt,
    })),
    totalAmount: toMoneyNumber(stats._sum.amount || 0),
    totalCount: stats._count,
  }
}

/**
 * 获取组织成员消费记录
 */
export async function getMemberUsage(
  organizationId: string,
  userId: string,
  options?: {
    startDate?: Date
    endDate?: Date
  },
) {
  const where: Record<string, unknown> = {
    organizationId,
    userId,
    type: 'task',
  }

  if (options?.startDate) {
    where.createdAt = { ...where.createdAt as object, gte: options.startDate }
  }

  if (options?.endDate) {
    where.createdAt = { ...where.createdAt as object, lte: options.endDate }
  }

  const usages = await prisma.organizationUsage.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  // 汇总统计
  const stats = await prisma.organizationUsage.aggregate({
    where,
    _sum: {
      amount: true,
    },
    _count: true,
  })

  // 获取成员信息
  const member = await prisma.organizationMember.findUnique({
    where: {
      organizationId_userId: {
        organizationId,
        userId,
      },
    },
  })

  return {
    member: member ? {
      id: member.id,
      role: member.role,
      quota: toMoneyNumber(member.quota || 0),
      status: member.status,
      joinedAt: member.joinedAt,
    } : null,
    usages: usages.map((u) => ({
      id: u.id,
      amount: toMoneyNumber(u.amount),
      type: u.type,
      description: u.description,
      createdAt: u.createdAt,
    })),
    totalAmount: toMoneyNumber(stats._sum.amount || 0),
    totalCount: stats._count,
  }
}

/**
 * 获取用户所属组织信息
 */
export async function getUserOrganization(userId: string): Promise<{ organizationId: string; role: string; quota: number } | null> {
  const member = await prisma.organizationMember.findFirst({
    where: {
      userId,
      status: 'active',
    },
    orderBy: { joinedAt: 'desc' },
  })

  if (!member) {
    return null
  }

  return {
    organizationId: member.organizationId,
    role: member.role,
    quota: toMoneyNumber(member.quota || 0),
  }
}

/**
 * 验证用户在组织中的角色
 */
export async function checkOrganizationRole(
  organizationId: string,
  userId: string,
  allowedRoles: string[],
): Promise<boolean> {
  const member = await prisma.organizationMember.findUnique({
    where: {
      organizationId_userId: {
        organizationId,
        userId,
      },
    },
    include: { organization: true },
  })

  if (!member || member.status !== 'active' || member.organization.status !== 'active') {
    return false
  }

  return allowedRoles.includes(member.role)
}
