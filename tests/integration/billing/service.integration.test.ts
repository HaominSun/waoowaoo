import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import { calcVoice } from '@/lib/billing/cost'
import { buildDefaultTaskBillingInfo } from '@/lib/billing/task-policy'
import { prepareTaskBilling, rollbackTaskBilling, settleTaskBilling } from '@/lib/billing/service'
import { TASK_TYPE, type TaskBillingInfo } from '@/lib/task/types'
import { prisma } from '../../helpers/prisma'
import { resetBillingState } from '../../helpers/db-reset'
import { createTestProject, createTestUser, seedBalance } from '../../helpers/billing-fixtures'

function expectBillableInfo(info: TaskBillingInfo | null | undefined): Extract<TaskBillingInfo, { billable: true }> {
  expect(info?.billable).toBe(true)
  if (!info || !info.billable) {
    throw new Error('Expected billable task billing info')
  }
  return info
}

describe('billing/service integration', () => {
  beforeEach(async () => {
    await resetBillingState()
  })

  it('marks task billing as skipped in OFF mode', async () => {
    process.env.BILLING_MODE = 'OFF'
    const user = await createTestUser()
    const project = await createTestProject(user.id)
    await seedBalance(user.id, 10)

    const info = buildDefaultTaskBillingInfo(TASK_TYPE.VOICE_LINE, { maxSeconds: 5 })!
    const result = await prepareTaskBilling({
      id: randomUUID(),
      userId: user.id,
      projectId: project.id,
      billingInfo: info,
    })

    expect(result?.billable).toBe(true)
    expect((result as TaskBillingInfo & { status: string }).status).toBe('skipped')
    expect(await prisma.creditLedgerEntry.count()).toBe(0)
    expect(await prisma.creditAccount.count()).toBe(0)
    expect(await prisma.quotaAllocationLog.count()).toBe(0)
  })

  it('records shadow audit in SHADOW mode and does not consume balance', async () => {
    process.env.BILLING_MODE = 'SHADOW'
    const user = await createTestUser()
    const project = await createTestProject(user.id)
    await seedBalance(user.id, 10)

    const info = buildDefaultTaskBillingInfo(TASK_TYPE.VOICE_LINE, { maxSeconds: 5 })!
    const taskId = randomUUID()
    const prepared = expectBillableInfo(await prepareTaskBilling({
      id: taskId,
      userId: user.id,
      projectId: project.id,
      billingInfo: info,
    }))

    expect(prepared.status).toBe('quoted')

    const settled = expectBillableInfo(await settleTaskBilling({
      id: taskId,
      userId: user.id,
      projectId: project.id,
      billingInfo: prepared,
    }, {
      result: { actualDurationSeconds: 2 },
    }))

    expect(settled.status).toBe('settled')
    expect(settled.chargedCost).toBe(0)

    const balance = await prisma.userBalance.findUnique({ where: { userId: user.id } })
    expect(balance?.balance).toBeCloseTo(10, 8)
    expect(balance?.totalSpent).toBeCloseTo(0, 8)
    const shadow = await prisma.balanceTransaction.findFirst({
      where: { userId: user.id, type: 'shadow_consume' },
    })
    expect(shadow).toBeTruthy()
    const recordedMatch = shadow?.description?.match(/¥(\d+(?:\.\d+)?)/)
    expect(recordedMatch?.[1]).toBeTruthy()
    const recorded = new Prisma.Decimal(recordedMatch![1])
    const ledger = await prisma.creditLedgerEntry.findUnique({ where: { taskId } })
    expect(ledger?.status).toBe('settled')
    expect(ledger?.userId).toBe(user.id)
    const actual = new Prisma.Decimal(ledger!.actualAmount!)
    const plan = new Prisma.Decimal(ledger!.planCreditPortion)
    const balancePortion = new Prisma.Decimal(ledger!.balancePortion)
    expect(actual.toDecimalPlaces(4).toFixed(4)).toBe(recorded.toDecimalPlaces(4).toFixed(4))
    expect(actual.toDecimalPlaces(2).toFixed(2)).toBe(recorded.toDecimalPlaces(2).toFixed(2))
    expect(plan.plus(balancePortion).equals(actual)).toBe(true)
    expect(actual.equals(new Prisma.Decimal(calcVoice(2).toFixed(6)))).toBe(true)
  })

  it('marks the shadow ledger rolled_back without moving balance', async () => {
    process.env.BILLING_MODE = 'SHADOW'
    const user = await createTestUser()
    const project = await createTestProject(user.id)
    await seedBalance(user.id, 10)

    const info = buildDefaultTaskBillingInfo(TASK_TYPE.VOICE_LINE, { maxSeconds: 5 })!
    const taskId = randomUUID()
    const prepared = expectBillableInfo(await prepareTaskBilling({
      id: taskId,
      userId: user.id,
      projectId: project.id,
      billingInfo: info,
    }))

    const rolled = expectBillableInfo(await rollbackTaskBilling({
      id: taskId,
      billingInfo: prepared,
    }))

    expect(rolled.status).toBe('quoted')
    const ledger = await prisma.creditLedgerEntry.findUnique({ where: { taskId } })
    expect(ledger?.status).toBe('rolled_back')
    expect(ledger?.rolledBackAt).not.toBeNull()
    const balance = await prisma.userBalance.findUnique({ where: { userId: user.id } })
    expect(Number(balance?.balance)).toBeCloseTo(10, 8)
    expect(Number(balance?.frozenAmount)).toBeCloseTo(0, 8)
    expect(await prisma.balanceTransaction.count({ where: { type: 'consume' } })).toBe(0)
  })

  it('freezes and settles in ENFORCE mode with actual usage', async () => {
    process.env.BILLING_MODE = 'ENFORCE'
    const user = await createTestUser()
    const project = await createTestProject(user.id)
    await seedBalance(user.id, 10)

    const info = buildDefaultTaskBillingInfo(TASK_TYPE.VOICE_LINE, { maxSeconds: 5 })!
    const taskId = randomUUID()
    const prepared = expectBillableInfo(await prepareTaskBilling({
      id: taskId,
      userId: user.id,
      projectId: project.id,
      billingInfo: info,
    }))

    expect(prepared.status).toBe('frozen')
    expect(prepared.freezeId).toBeTruthy()

    const settled = expectBillableInfo(await settleTaskBilling({
      id: taskId,
      userId: user.id,
      projectId: project.id,
      billingInfo: prepared,
    }, {
      result: { actualDurationSeconds: 2 },
    }))

    expect(settled.status).toBe('settled')
    expect(settled.chargedCost).toBeCloseTo(calcVoice(2), 8)

    const balance = await prisma.userBalance.findUnique({ where: { userId: user.id } })
    expect(balance?.totalSpent).toBeCloseTo(calcVoice(2), 8)
    expect(balance?.frozenAmount).toBeCloseTo(0, 8)
    expect(await prisma.creditLedgerEntry.count()).toBe(0)
  })

  it('rolls back frozen billing in ENFORCE mode', async () => {
    process.env.BILLING_MODE = 'ENFORCE'
    const user = await createTestUser()
    const project = await createTestProject(user.id)
    await seedBalance(user.id, 10)

    const info = buildDefaultTaskBillingInfo(TASK_TYPE.VOICE_LINE, { maxSeconds: 5 })!
    const taskId = randomUUID()
    const prepared = expectBillableInfo(await prepareTaskBilling({
      id: taskId,
      userId: user.id,
      projectId: project.id,
      billingInfo: info,
    }))

    const rolled = expectBillableInfo(await rollbackTaskBilling({
      id: taskId,
      billingInfo: prepared,
    }))

    expect(rolled.status).toBe('rolled_back')
    const balance = await prisma.userBalance.findUnique({ where: { userId: user.id } })
    expect(balance?.balance).toBeCloseTo(10, 8)
    expect(balance?.frozenAmount).toBeCloseTo(0, 8)
  })
})
