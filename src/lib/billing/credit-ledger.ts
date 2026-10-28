import { logError as _ulogError } from '@/lib/logging/core'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import {
  CREDITS_PER_CNY_CONFIG_KEY,
  DEFAULT_CREDITS_PER_CNY,
  organizationBalanceHasArrears,
} from './credit-quota'
import { toMoneyNumber } from './money'
import type { BillingMode } from './types'

/** Stable holder for the shared organization pool. Member caps use member:<id>. */
export const CREDIT_ACCOUNT_ORG_HOLDER_KEY = 'organization'

const SHADOW_NOTE = 'Shadow ledger only. Balances are not moved and tiered deduction is not applied.'

export type ShadowLedgerPhase = 'prepare' | 'settle' | 'rollback'
export type QuotaAllocationTarget = 'member_quota' | 'pool_quota' | 'member_cap'

export function creditAccountHolderKey(scope: 'organization' | 'member', memberId?: string | null): string {
  if (scope === 'organization') return CREDIT_ACCOUNT_ORG_HOLDER_KEY
  if (!memberId) {
    throw new Error('member credit account requires memberId')
  }
  return `member:${memberId}`
}

export type ShadowCreditLedgerInput = {
  mode: BillingMode
  phase: ShadowLedgerPhase
  taskId: string
  userId?: string | null
  projectId?: string | null
  organizationId?: string | null
  operationType?: string | null
  quantity?: number | null
  estimatedAmount?: number | null
  actualAmount?: number | null
  planCreditPortion?: number | null
  balancePortion?: number | null
}

/**
 * Writes one credit_ledger_entries row per task when BILLING_MODE is SHADOW.
 * OFF and ENFORCE are no-ops. Failures are logged and do not affect billing.
 * Portions are copied from the existing quote. planTieredDeduction is not applied.
 */
export async function recordShadowCreditLedger(input: ShadowCreditLedgerInput): Promise<void> {
  try {
    if (input.mode !== 'SHADOW') return

    if (input.phase === 'rollback') {
      await prisma.creditLedgerEntry.updateMany({
        where: { taskId: input.taskId },
        data: {
          status: 'rolled_back',
          rolledBackAt: new Date(),
        },
      })
      return
    }

    if (!input.userId) {
      _ulogError('[Billing] shadow credit ledger skipped, missing userId', {
        taskId: input.taskId,
        phase: input.phase,
      })
      return
    }

    const now = new Date()
    const status = input.phase === 'settle' ? 'settled' : 'frozen'
    const metadata: Prisma.InputJsonValue = {
      mode: 'SHADOW',
      phase: input.phase,
      note: SHADOW_NOTE,
    }
    await prisma.creditLedgerEntry.upsert({
      where: { taskId: input.taskId },
      create: {
        taskId: input.taskId,
        userId: input.userId,
        projectId: input.projectId || null,
        organizationId: input.organizationId || null,
        operationType: input.operationType || 'unknown',
        quantity: input.quantity ?? 0,
        estimatedAmount: input.estimatedAmount ?? 0,
        actualAmount: input.phase === 'settle' ? input.actualAmount ?? null : null,
        planCreditPortion: input.planCreditPortion ?? 0,
        balancePortion: input.balancePortion ?? 0,
        status,
        currency: 'CNY',
        frozenAt: now,
        settledAt: input.phase === 'settle' ? now : null,
        metadata,
      },
      update: {
        projectId: input.projectId || null,
        organizationId: input.organizationId || null,
        operationType: input.operationType || 'unknown',
        quantity: input.quantity ?? 0,
        estimatedAmount: input.estimatedAmount ?? 0,
        ...(input.phase === 'settle'
          ? { actualAmount: input.actualAmount ?? null, settledAt: now }
          : { frozenAt: now }),
        planCreditPortion: input.planCreditPortion ?? 0,
        balancePortion: input.balancePortion ?? 0,
        status,
        metadata,
      },
    })
  } catch (error) {
    _ulogError('[Billing] shadow credit ledger write failed', error)
  }
}

export async function getCreditsPerCny(): Promise<number> {
  const row = await prisma.systemConfig.findUnique({
    where: { key: CREDITS_PER_CNY_CONFIG_KEY },
  })
  const parsed = Number(row?.value)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CREDITS_PER_CNY
  return parsed
}

/**
 * Opens a period bucket. Does not write QuotaAllocationLog; the caller records the audit
 * row with the actor and reason when a quota value actually changes.
 */
export async function ensureCreditAccount(input: {
  organizationId: string
  scope: 'organization' | 'member'
  memberId?: string | null
  periodStart: Date
  periodEnd: Date
  quotaAmount: number | null
}) {
  const holderKey = creditAccountHolderKey(input.scope, input.memberId)
  return prisma.creditAccount.upsert({
    where: {
      organizationId_holderKey_periodStart_periodEnd: {
        organizationId: input.organizationId,
        holderKey,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
      },
    },
    create: {
      organizationId: input.organizationId,
      scope: input.scope,
      memberId: input.scope === 'member' ? input.memberId ?? null : null,
      holderKey,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      quotaAmount: input.quotaAmount,
      currency: 'CNY',
    },
    update: {
      quotaAmount: input.quotaAmount,
    },
  })
}

/** Append-only audit of a quota change. Does not itself update the quota. */
export async function recordQuotaAllocationChange(input: {
  actorId?: string | null
  organizationId: string
  memberId?: string | null
  creditAccountId?: string | null
  target: QuotaAllocationTarget
  oldValue: number | null
  newValue: number | null
  reason: string
}) {
  return prisma.quotaAllocationLog.create({
    data: {
      actorId: input.actorId || null,
      organizationId: input.organizationId,
      memberId: input.memberId || null,
      creditAccountId: input.creditAccountId || null,
      target: input.target,
      oldValue: input.oldValue,
      newValue: input.newValue,
      reason: input.reason,
    },
  })
}

/** Read path for the later "reject new tasks while in arrears" gate. Not called by prepare. */
export async function organizationHasArrears(organizationId: string): Promise<boolean> {
  const balance = await prisma.organizationBalance.findUnique({
    where: { organizationId },
    select: { arrears: true },
  })
  if (!balance) return false
  return organizationBalanceHasArrears(toMoneyNumber(balance.arrears))
}
