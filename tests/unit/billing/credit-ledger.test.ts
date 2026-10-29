import { beforeEach, describe, expect, it, vi } from 'vitest'

const prismaMock = vi.hoisted(() => ({
  creditLedgerEntry: {
    upsert: vi.fn(),
    updateMany: vi.fn(),
  },
  systemConfig: { findUnique: vi.fn() },
  creditAccount: { upsert: vi.fn() },
  quotaAllocationLog: { create: vi.fn() },
  organizationBalance: { findUnique: vi.fn() },
}))

const logError = vi.hoisted(() => vi.fn())

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/logging/core', () => ({ logError, logInfo: vi.fn() }))

import {
  creditAccountHolderKey,
  ensureCreditAccount,
  getCreditsPerCny,
  organizationHasArrears,
  recordQuotaAllocationChange,
  recordShadowCreditLedger,
} from '@/lib/billing/credit-ledger'

describe('recordShadowCreditLedger', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prismaMock.creditLedgerEntry.upsert.mockResolvedValue({ id: 'ledger-1' })
    prismaMock.creditLedgerEntry.updateMany.mockResolvedValue({ count: 1 })
  })

  it('writes nothing when billing mode is OFF or ENFORCE', async () => {
    await recordShadowCreditLedger({ mode: 'OFF', phase: 'prepare', taskId: 't-off', userId: 'u1' })
    await recordShadowCreditLedger({ mode: 'ENFORCE', phase: 'settle', taskId: 't-enforce', userId: 'u1' })
    await recordShadowCreditLedger({ mode: 'OFF', phase: 'rollback', taskId: 't-off-rb' })

    expect(prismaMock.creditLedgerEntry.upsert).not.toHaveBeenCalled()
    expect(prismaMock.creditLedgerEntry.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.creditAccount.upsert).not.toHaveBeenCalled()
    expect(prismaMock.quotaAllocationLog.create).not.toHaveBeenCalled()
  })

  it('upserts one frozen row per task in SHADOW and does not insert on rollback when absent', async () => {
    await recordShadowCreditLedger({
      mode: 'SHADOW',
      phase: 'prepare',
      taskId: 'task-1',
      userId: 'user-1',
      projectId: 'project-1',
      operationType: 'image',
      quantity: 2,
      estimatedAmount: 4.5,
      balancePortion: 4.5,
    })
    expect(prismaMock.creditLedgerEntry.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { taskId: 'task-1' },
      create: expect.objectContaining({
        status: 'frozen',
        userId: 'user-1',
        estimatedAmount: 4.5,
        currency: 'CNY',
      }),
    }))

    await recordShadowCreditLedger({
      mode: 'SHADOW',
      phase: 'settle',
      taskId: 'task-1',
      userId: 'user-1',
      actualAmount: 3,
      estimatedAmount: 4.5,
      planCreditPortion: 1,
      balancePortion: 2,
    })
    expect(prismaMock.creditLedgerEntry.upsert).toHaveBeenLastCalledWith(expect.objectContaining({
      create: expect.objectContaining({ status: 'settled', actualAmount: 3 }),
      update: expect.objectContaining({ status: 'settled', actualAmount: 3, planCreditPortion: 1 }),
    }))

    prismaMock.creditLedgerEntry.updateMany.mockResolvedValueOnce({ count: 0 })
    await recordShadowCreditLedger({ mode: 'SHADOW', phase: 'rollback', taskId: 'task-missing' })
    expect(prismaMock.creditLedgerEntry.updateMany).toHaveBeenCalledWith({
      where: { taskId: 'task-missing' },
      data: expect.objectContaining({ status: 'rolled_back' }),
    })
    expect(prismaMock.creditLedgerEntry.upsert).toHaveBeenCalledTimes(2)
  })

  it('skips a SHADOW prepare without a user and swallows write failures', async () => {
    await recordShadowCreditLedger({ mode: 'SHADOW', phase: 'prepare', taskId: 'task-no-user' })
    expect(prismaMock.creditLedgerEntry.upsert).not.toHaveBeenCalled()

    prismaMock.creditLedgerEntry.upsert.mockRejectedValueOnce(new Error('db down'))
    await expect(recordShadowCreditLedger({
      mode: 'SHADOW',
      phase: 'prepare',
      taskId: 'task-fail',
      userId: 'user-1',
    })).resolves.toBeUndefined()
  })
})

describe('credit account and quota audit extension points', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('builds holder keys that stay unique for the organization pool', () => {
    expect(creditAccountHolderKey('organization')).toBe('organization')
    expect(creditAccountHolderKey('member', 'member-1')).toBe('member:member-1')
    expect(() => creditAccountHolderKey('member', null)).toThrow(/memberId/)
  })

  it('upserts a period account without writing the allocation log itself', async () => {
    const periodStart = new Date('2026-10-01T00:00:00.000Z')
    const periodEnd = new Date('2026-11-01T00:00:00.000Z')
    prismaMock.creditAccount.upsert.mockResolvedValue({ id: 'account-1' })

    await ensureCreditAccount({
      organizationId: 'org-1',
      scope: 'member',
      memberId: 'member-1',
      periodStart,
      periodEnd,
      quotaAmount: null,
    })

    expect(prismaMock.creditAccount.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        organizationId_holderKey_periodStart_periodEnd: {
          organizationId: 'org-1',
          holderKey: 'member:member-1',
          periodStart,
          periodEnd,
        },
      },
      create: expect.objectContaining({ quotaAmount: null, scope: 'member' }),
    }))
    expect(prismaMock.quotaAllocationLog.create).not.toHaveBeenCalled()

    await ensureCreditAccount({
      organizationId: 'org-1',
      scope: 'organization',
      periodStart,
      periodEnd,
      quotaAmount: 500,
    })
    expect(prismaMock.creditAccount.upsert).toHaveBeenLastCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        holderKey: 'organization',
        memberId: null,
        quotaAmount: 500,
      }),
    }))
  })

  it('records who changed a quota, including null unlimited values', async () => {
    prismaMock.quotaAllocationLog.create.mockResolvedValue({ id: 'log-1' })
    await recordQuotaAllocationChange({
      actorId: 'admin-1',
      organizationId: 'org-1',
      memberId: 'member-1',
      target: 'member_quota',
      oldValue: 0,
      newValue: null,
      reason: 'correct a legacy disable',
    })
    expect(prismaMock.quotaAllocationLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'admin-1',
        oldValue: 0,
        newValue: null,
        reason: 'correct a legacy disable',
      }),
    })
  })
})

describe('credits_per_cny and arrears reads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('falls back to the placeholder rate when config is missing or unusable', async () => {
    prismaMock.systemConfig.findUnique.mockResolvedValueOnce(null)
    await expect(getCreditsPerCny()).resolves.toBe(1)
    prismaMock.systemConfig.findUnique.mockResolvedValueOnce({ value: '100' })
    await expect(getCreditsPerCny()).resolves.toBe(100)
    prismaMock.systemConfig.findUnique.mockResolvedValueOnce({ value: '0' })
    await expect(getCreditsPerCny()).resolves.toBe(1)
    prismaMock.systemConfig.findUnique.mockResolvedValueOnce({ value: 'nope' })
    await expect(getCreditsPerCny()).resolves.toBe(1)
  })

  it('reads organization arrears without treating a missing balance as debt', async () => {
    prismaMock.organizationBalance.findUnique.mockResolvedValueOnce(null)
    await expect(organizationHasArrears('org-1')).resolves.toBe(false)
    prismaMock.organizationBalance.findUnique.mockResolvedValueOnce({ arrears: 0 })
    await expect(organizationHasArrears('org-1')).resolves.toBe(false)
    prismaMock.organizationBalance.findUnique.mockResolvedValueOnce({ arrears: '2.500000' })
    await expect(organizationHasArrears('org-1')).resolves.toBe(true)
  })
})
