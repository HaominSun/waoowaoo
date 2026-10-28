import { roundMoney, toMoneyNumber, type MoneyValue } from './money'

/**
 * Tiered credit quotas. These helpers are the extension point for a later
 * wiring of prepare/settle. They do not move balances.
 *
 * Quota semantics: null = unlimited, 0 (and any negative) = forbidden.
 * Amounts stay in CNY. Display credits use credits_per_cny, which is a placeholder.
 * Period boundaries are not decided here. Callers pass periodStart/periodEnd.
 */

const MONEY_SCALE = 6

export const OVERRUN_TOP_UP_RATIO = 0.2
export const CREDITS_PER_CNY_CONFIG_KEY = 'credits_per_cny'
/** Placeholder. 1 CNY displays as 1 credit until product sets the rate. */
export const DEFAULT_CREDITS_PER_CNY = 1

export type QuotaClass = 'unlimited' | 'forbidden' | 'limited'
export type OveragePolicy = 'balance' | 'block'
export type DeductionPhase = 'authorize' | 'settle'
export type TieredDeductionRejection =
  | 'ORGANIZATION_IN_ARREARS'
  | 'MEMBER_FORBIDDEN'
  | 'MEMBER_CAP_EXCEEDED'
  | 'OVERAGE_BLOCKED'
  | 'INSUFFICIENT_BALANCE'

export type MemberQuotaSnapshot = {
  /** True when the member may consume a positive amount. */
  hasQuota: boolean
  /** null means unlimited. */
  quota: number | null
  /** Settled usage plus frozen-but-unsettled holds. Ignores OrganizationMember.quotaUsed. */
  used: number
  /** null when the quota is unlimited. */
  remaining: number | null
  frozen: number
}

export type TieredDeductionInput = {
  phase: DeductionPhase
  estimatedAmount: number
  /** Used on settle. Authorize bills the estimate. */
  actualAmount?: number
  /** null = unlimited, 0 = forbidden. */
  memberCap: number | null
  /**
   * Usage already counting against the cap. Callers must include frozen-but-unsettled
   * holds. checkMemberQuota().used is the matching read.
   */
  memberUsed: number
  planCreditsRemaining: number
  balanceAvailable: number
  overagePolicy: OveragePolicy
  existingArrears: number
}

export type TieredDeductionResult = {
  accepted: boolean
  reason: TieredDeductionRejection | null
  billableAmount: number
  topUpAmount: number
  /** Actual above the 20% cap. Not billed and not recorded as arrears. */
  overrunForgiven: number
  planCreditPortion: number
  balancePortion: number
  arrearsPortion: number
  balanceAfter: number
  arrearsAfter: number
  memberUsedAfter: number
}

function money(value: number): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return roundMoney(Math.max(0, numeric), MONEY_SCALE)
}

export function calendarMonthStart(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1)
}

export function readStoredQuota(value: MoneyValue): number | null {
  if (value === null || value === undefined) return null
  return toMoneyNumber(value)
}

export function classifyQuota(quota: number | null | undefined): QuotaClass {
  if (quota === null || quota === undefined) return 'unlimited'
  if (quota <= 0) return 'forbidden'
  return 'limited'
}

export function frozenHoldAmount(sum: {
  amount?: MoneyValue
  planCreditAmount?: MoneyValue
  balanceAmount?: MoneyValue
} | null | undefined): number {
  const plan = toMoneyNumber(sum?.planCreditAmount)
  const balance = toMoneyNumber(sum?.balanceAmount)
  const parts = money(plan + balance)
  if (parts > 0) return parts
  return money(toMoneyNumber(sum?.amount))
}

export function evaluateMemberQuota(input: {
  quota: number | null
  settledAmount: number
  frozenAmount: number
}): MemberQuotaSnapshot {
  const settled = money(input.settledAmount)
  const frozen = money(input.frozenAmount)
  const used = money(settled + frozen)
  if (input.quota === null) {
    return { hasQuota: true, quota: null, used, remaining: null, frozen }
  }
  const quota = money(input.quota)
  if (quota <= 0) {
    return { hasQuota: false, quota: 0, used, remaining: 0, frozen }
  }
  const remaining = money(Math.max(0, quota - used))
  return {
    hasQuota: remaining > 0,
    quota,
    used,
    remaining,
    frozen,
  }
}

export function organizationBalanceHasArrears(arrears: number): boolean {
  return money(arrears) > 0
}

export function cnyToDisplayCredits(amountCny: number, creditsPerCny = DEFAULT_CREDITS_PER_CNY): number {
  const amount = money(amountCny)
  const rate = Number(creditsPerCny)
  if (!Number.isFinite(rate) || rate <= 0) return 0
  return roundMoney(amount * rate, MONEY_SCALE)
}

/**
 * Billable settle amount is min(actual, estimate + 20% of estimate).
 * 19.99 / 20 / 20.01 below are the overrun on a 100 estimate.
 */
export function capOverrunTopUp(estimatedAmount: number, actualAmount: number): {
  billable: number
  topUp: number
  forgiven: number
} {
  const estimate = money(estimatedAmount)
  const actual = money(actualAmount)
  const allowance = money(estimate * OVERRUN_TOP_UP_RATIO)
  const maxBillable = money(estimate + allowance)
  const billable = money(Math.min(actual, maxBillable))
  return {
    billable,
    topUp: money(Math.max(0, billable - estimate)),
    forgiven: money(Math.max(0, actual - billable)),
  }
}

function emptyResult(partial: Omit<TieredDeductionResult, 'accepted' | 'reason'>): Omit<TieredDeductionResult, 'accepted' | 'reason'> {
  return partial
}

/**
 * Deduction order for a later wiring step:
 * member cap → plan credits → balance, and balance is used only when overagePolicy is balance.
 *
 * Authorize rejects an organization that already has arrears, a forbidden member,
 * a cap miss, blocked overage, or a balance that cannot cover the estimate.
 * It does not create arrears.
 *
 * Settle caps the bill at 120% of the estimate. Balance is never drawn below 0.
 * The uncovered billable amount is arrears. Spend above the 20% cap is forgiven,
 * not added to arrears. Existing arrears are not auto-repaid.
 */
export function planTieredDeduction(input: TieredDeductionInput): TieredDeductionResult {
  const estimated = money(input.estimatedAmount)
  const memberUsed = money(input.memberUsed)
  const planRemaining = money(input.planCreditsRemaining)
  const balanceAvailable = money(input.balanceAvailable)
  const existingArrears = money(input.existingArrears)
  const memberCap = input.memberCap === null || input.memberCap === undefined
    ? null
    : money(input.memberCap)
  const priced = input.phase === 'settle'
    ? capOverrunTopUp(estimated, input.actualAmount ?? estimated)
    : { billable: estimated, topUp: 0, forgiven: 0 }

  const unchanged = emptyResult({
    billableAmount: priced.billable,
    topUpAmount: priced.topUp,
    overrunForgiven: priced.forgiven,
    planCreditPortion: 0,
    balancePortion: 0,
    arrearsPortion: 0,
    balanceAfter: balanceAvailable,
    arrearsAfter: existingArrears,
    memberUsedAfter: memberUsed,
  })
  const reject = (reason: TieredDeductionRejection): TieredDeductionResult => ({
    accepted: false,
    reason,
    ...unchanged,
  })

  if (input.phase === 'authorize' && existingArrears > 0) {
    return reject('ORGANIZATION_IN_ARREARS')
  }
  if (priced.billable > 0 && memberCap !== null && memberCap <= 0) {
    return reject('MEMBER_FORBIDDEN')
  }
  const nextUsed = money(memberUsed + priced.billable)
  if (priced.billable > 0 && memberCap !== null && nextUsed > memberCap) {
    return reject('MEMBER_CAP_EXCEEDED')
  }

  const planCreditPortion = money(Math.min(priced.billable, planRemaining))
  const remainder = money(priced.billable - planCreditPortion)
  const policy = input.overagePolicy === 'balance' ? 'balance' : 'block'
  if (input.phase === 'authorize' && remainder > 0 && policy !== 'balance') {
    return reject('OVERAGE_BLOCKED')
  }
  if (input.phase === 'authorize' && remainder > 0 && balanceAvailable < remainder) {
    return reject('INSUFFICIENT_BALANCE')
  }

  const balancePortion = policy === 'balance' ? money(Math.min(remainder, balanceAvailable)) : 0
  const arrearsPortion = money(priced.billable - planCreditPortion - balancePortion)
  return {
    accepted: true,
    reason: null,
    billableAmount: priced.billable,
    topUpAmount: priced.topUp,
    overrunForgiven: priced.forgiven,
    planCreditPortion,
    balancePortion,
    arrearsPortion,
    balanceAfter: money(balanceAvailable - balancePortion),
    arrearsAfter: money(existingArrears + arrearsPortion),
    memberUsedAfter: nextUsed,
  }
}
