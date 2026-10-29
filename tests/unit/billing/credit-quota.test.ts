import { Prisma } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import {
  calendarMonthStart,
  capOverrunTopUp,
  classifyQuota,
  cnyToDisplayCredits,
  DEFAULT_CREDITS_PER_CNY,
  evaluateMemberQuota,
  frozenHoldAmount,
  organizationBalanceHasArrears,
  planTieredDeduction,
  readStoredQuota,
  splitCreditPortions,
  type TieredDeductionInput,
} from '@/lib/billing/credit-quota'

function expectPortionsSum(total: number, plan?: number | null, balance?: number | null) {
  const split = splitCreditPortions(total, plan, balance)
  const sum = new Prisma.Decimal(split.planCreditPortion.toFixed(6))
    .plus(new Prisma.Decimal(split.balancePortion.toFixed(6)))
  expect(sum.equals(new Prisma.Decimal(total.toFixed(6)))).toBe(true)
  return split
}

function deduction(overrides: Partial<TieredDeductionInput> = {}) {
  return planTieredDeduction({
    phase: 'authorize',
    estimatedAmount: 100,
    memberCap: null,
    memberUsed: 0,
    planCreditsRemaining: 100,
    balanceAvailable: 0,
    overagePolicy: 'block',
    existingArrears: 0,
    ...overrides,
  })
}

describe('quota semantics', () => {
  it('classifies null as unlimited, 0 as forbidden, and a positive amount as limited', () => {
    expect(readStoredQuota(null)).toBeNull()
    expect(readStoredQuota(undefined)).toBeNull()
    expect(readStoredQuota(0)).toBe(0)
    expect(readStoredQuota('10.5')).toBe(10.5)
    const month = calendarMonthStart(new Date('2026-10-15T12:00:00.000Z'))
    expect(month.getMonth()).toBe(9)
    expect(month.getDate()).toBe(1)
    expect(classifyQuota(null)).toBe('unlimited')
    expect(classifyQuota(undefined)).toBe('unlimited')
    expect(classifyQuota(0)).toBe('forbidden')
    expect(classifyQuota(-1)).toBe('forbidden')
    expect(classifyQuota(0.01)).toBe('limited')
  })

  it('treats a null cap as unlimited and a 0 cap as forbidden', () => {
    expect(evaluateMemberQuota({ quota: null, settledAmount: 1000, frozenAmount: 50 })).toEqual({
      hasQuota: true,
      quota: null,
      used: 1050,
      remaining: null,
      frozen: 50,
    })
    expect(evaluateMemberQuota({ quota: 0, settledAmount: 0, frozenAmount: 0 })).toEqual({
      hasQuota: false,
      quota: 0,
      used: 0,
      remaining: 0,
      frozen: 0,
    })
    expect(evaluateMemberQuota({ quota: 0, settledAmount: 10, frozenAmount: 1 }).hasQuota).toBe(false)
  })

  it('includes frozen holds in the cap and ignores a fully consumed allowance', () => {
    const open = evaluateMemberQuota({ quota: 20, settledAmount: 8, frozenAmount: 7 })
    expect(open).toMatchObject({ hasQuota: true, used: 15, remaining: 5, frozen: 7 })

    const closed = evaluateMemberQuota({ quota: 20, settledAmount: 12, frozenAmount: 8 })
    expect(closed).toMatchObject({ hasQuota: false, used: 20, remaining: 0 })
  })

  it('counts plan plus balance on a freeze, and falls back to amount when both are zero', () => {
    expect(frozenHoldAmount({ planCreditAmount: 4, balanceAmount: 6, amount: 1 })).toBe(10)
    expect(frozenHoldAmount({ planCreditAmount: 0, balanceAmount: 0, amount: 3 })).toBe(3)
    expect(frozenHoldAmount(null)).toBe(0)
  })
})

describe('planTieredDeduction', () => {
  it('checks the member cap, including frozen usage, before plan credits or balance', () => {
    const fit = deduction({
      memberCap: 20,
      memberUsed: 18,
      estimatedAmount: 2,
      planCreditsRemaining: 0,
      balanceAvailable: 50,
      overagePolicy: 'balance',
    })
    expect(fit.accepted).toBe(true)
    expect(fit.memberUsedAfter).toBe(20)
    expect(fit.planCreditPortion).toBe(0)
    expect(fit.balancePortion).toBe(2)

    const overrun = deduction({
      memberCap: 20,
      memberUsed: 18,
      estimatedAmount: 2.01,
      planCreditsRemaining: 100,
      balanceAvailable: 100,
      overagePolicy: 'balance',
    })
    expect(overrun.accepted).toBe(false)
    expect(overrun.reason).toBe('MEMBER_CAP_EXCEEDED')
    expect(overrun.planCreditPortion).toBe(0)
    expect(overrun.balancePortion).toBe(0)
    expect(overrun.memberUsedAfter).toBe(18)
  })

  it('rejects a forbidden member and an organization that already has arrears', () => {
    expect(deduction({ memberCap: 0, estimatedAmount: 1 }).reason).toBe('MEMBER_FORBIDDEN')
    expect(deduction({ memberCap: 0, estimatedAmount: 0 }).accepted).toBe(true)
    const arrears = deduction({ existingArrears: 0.01, planCreditsRemaining: 1000, balanceAvailable: 1000 })
    expect(arrears.reason).toBe('ORGANIZATION_IN_ARREARS')
    expect(arrears.arrearsPortion).toBe(0)
    expect(arrears.balanceAfter).toBe(1000)
  })

  it('spends plan credits before balance and only uses balance when the policy allows it', () => {
    const covered = deduction({
      estimatedAmount: 100,
      planCreditsRemaining: 40,
      balanceAvailable: 100,
      overagePolicy: 'balance',
    })
    expect(covered).toMatchObject({
      accepted: true,
      planCreditPortion: 40,
      balancePortion: 60,
      arrearsPortion: 0,
      balanceAfter: 40,
    })

    const blocked = deduction({
      estimatedAmount: 100,
      planCreditsRemaining: 40,
      balanceAvailable: 100,
      overagePolicy: 'block',
    })
    expect(blocked.reason).toBe('OVERAGE_BLOCKED')
    expect(blocked.balancePortion).toBe(0)
    expect(blocked.arrearsPortion).toBe(0)

    const short = deduction({
      estimatedAmount: 100,
      planCreditsRemaining: 30,
      balanceAvailable: 40,
      overagePolicy: 'balance',
    })
    expect(short.reason).toBe('INSUFFICIENT_BALANCE')
    expect(short.balanceAfter).toBe(40)
    expect(short.arrearsAfter).toBe(0)
  })

  it('caps settle overrun at 20% of the estimate (19.99 / 20 / 20.01)', () => {
    const within = deduction({
      phase: 'settle',
      estimatedAmount: 100,
      actualAmount: 119.99,
      planCreditsRemaining: 0,
      balanceAvailable: 1000,
      overagePolicy: 'balance',
    })
    expect(within).toMatchObject({ billableAmount: 119.99, topUpAmount: 19.99, overrunForgiven: 0, balancePortion: 119.99 })

    const exact = deduction({
      phase: 'settle',
      estimatedAmount: 100,
      actualAmount: 120,
      planCreditsRemaining: 0,
      balanceAvailable: 1000,
      overagePolicy: 'balance',
    })
    expect(exact).toMatchObject({ billableAmount: 120, topUpAmount: 20, overrunForgiven: 0 })

    const over = deduction({
      phase: 'settle',
      estimatedAmount: 100,
      actualAmount: 120.01,
      planCreditsRemaining: 0,
      balanceAvailable: 100,
      overagePolicy: 'balance',
    })
    expect(over).toMatchObject({
      accepted: true,
      billableAmount: 120,
      topUpAmount: 20,
      overrunForgiven: 0.01,
      balancePortion: 100,
      arrearsPortion: 20,
      balanceAfter: 0,
      arrearsAfter: 20,
    })
    expect(capOverrunTopUp(100, 120.01)).toEqual({ billable: 120, topUp: 20, forgiven: 0.01 })
  })

  it('keeps balance at zero and records the shortfall as arrears without repaying old arrears', () => {
    const settled = deduction({
      phase: 'settle',
      estimatedAmount: 100,
      actualAmount: 100,
      planCreditsRemaining: 30,
      balanceAvailable: 40,
      overagePolicy: 'balance',
      existingArrears: 5,
    })
    expect(settled).toMatchObject({
      accepted: true,
      planCreditPortion: 30,
      balancePortion: 40,
      arrearsPortion: 30,
      balanceAfter: 0,
      arrearsAfter: 35,
    })

    const blocked = deduction({
      phase: 'settle',
      estimatedAmount: 100,
      actualAmount: 100,
      planCreditsRemaining: 30,
      balanceAvailable: 40,
      overagePolicy: 'block',
    })
    expect(blocked).toMatchObject({
      balancePortion: 0,
      arrearsPortion: 70,
      balanceAfter: 40,
    })
  })

  it('does not let an authorize actual amount bypass the estimate', () => {
    const quoted = deduction({
      estimatedAmount: 100,
      actualAmount: 1000,
      planCreditsRemaining: 1000,
    })
    expect(quoted.billableAmount).toBe(100)
    expect(quoted.topUpAmount).toBe(0)
  })

  it('treats a positive arrears balance as blocking new work', () => {
    expect(organizationBalanceHasArrears(0)).toBe(false)
    expect(organizationBalanceHasArrears(0.0000004)).toBe(false)
    expect(organizationBalanceHasArrears(0.01)).toBe(true)
  })
})

describe('splitCreditPortions', () => {
  it('keeps a plan-only charge from also taking the full balance', () => {
    expect(expectPortionsSum(10, 10, 0)).toEqual({ planCreditPortion: 10, balancePortion: 0 })
    expect(expectPortionsSum(10, 10, undefined)).toEqual({ planCreditPortion: 10, balancePortion: 0 })
  })

  it('splits a partial plan credit and does not fall back to the whole total', () => {
    expect(expectPortionsSum(10, 4, 6)).toEqual({ planCreditPortion: 4, balancePortion: 6 })
    expect(expectPortionsSum(10, 4, undefined)).toEqual({ planCreditPortion: 4, balancePortion: 6 })
    expect(expectPortionsSum(10, 4, 10)).toEqual({ planCreditPortion: 4, balancePortion: 6 })
  })

  it('assigns the whole charge to balance when plan credit is absent or zero', () => {
    expect(expectPortionsSum(10, 0, 10)).toEqual({ planCreditPortion: 0, balancePortion: 10 })
    expect(expectPortionsSum(10, undefined, undefined)).toEqual({ planCreditPortion: 0, balancePortion: 10 })
    expect(expectPortionsSum(10, undefined, 10)).toEqual({ planCreditPortion: 0, balancePortion: 10 })
  })

  it('sums 0.1 and 0.2 to 0.3 with decimal arithmetic', () => {
    expect(expectPortionsSum(0.3, 0.1, 0.2)).toEqual({ planCreditPortion: 0.1, balancePortion: 0.2 })
  })

  it('tops up a short explicit balance so the portions still equal the total', () => {
    expect(expectPortionsSum(10, 1, 1)).toEqual({ planCreditPortion: 1, balancePortion: 9 })
  })
})

describe('credits_per_cny display conversion', () => {
  it('uses the placeholder rate of 1 CNY = 1 credit', () => {
    expect(DEFAULT_CREDITS_PER_CNY).toBe(1)
    expect(cnyToDisplayCredits(12.5)).toBe(12.5)
    expect(cnyToDisplayCredits(12.5, 100)).toBe(1250)
    expect(cnyToDisplayCredits(12.5, 0)).toBe(0)
  })
})
