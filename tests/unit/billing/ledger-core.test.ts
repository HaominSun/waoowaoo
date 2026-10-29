import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  userBalance: { findUnique: vi.fn(), create: vi.fn() },
  balanceFreeze: { findUnique: vi.fn() },
}))
const reportingMock = vi.hoisted(() => ({
  recordUsageCostOnly: vi.fn(),
  buildBillingMeta: vi.fn(() => ({})),
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/billing/reporting', () => reportingMock)
vi.mock('@/lib/logging/core', () => ({ logInfo: vi.fn(), logError: vi.fn() }))

import {
  checkBalance,
  confirmChargeWithRecord,
  freezeBalance,
  getBalance,
  addBalance,
  getFreezeByIdempotencyKey,
  increasePendingFreezeAmount,
  recordShadowUsage,
  rollbackFreeze,
} from '@/lib/billing/ledger'
import { BillingOperationError } from '@/lib/billing/errors'

const now = new Date('2026-01-01T00:00:00Z')
const balanceRow = (balance = 10) => ({
  id: 'b1', userId: 'u1', balance, frozenAmount: 0, totalSpent: 0, createdAt: now, updatedAt: now,
})

function buildTx() {
  return {
    userBalance: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    balanceTransaction: { findFirst: vi.fn(), create: vi.fn() },
    balanceFreeze: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  }
}
type Tx = ReturnType<typeof buildTx>
let tx: Tx

const recordParams = {
  projectId: 'p1', action: 'image', apiType: 'image' as never, model: 'm', quantity: 1, unit: 'image' as never,
}

beforeEach(() => {
  vi.clearAllMocks()
  tx = buildTx()
  prismaMock.$transaction.mockImplementation(async (cb: (t: Tx) => unknown) => cb(tx))
})

describe('getBalance / checkBalance / getFreezeByIdempotencyKey', () => {
  it('returns existing balance snapshot', async () => {
    prismaMock.userBalance.findUnique.mockResolvedValue(balanceRow(12.5))
    await expect(getBalance('u1')).resolves.toMatchObject({ userId: 'u1', balance: 12.5 })
    expect(prismaMock.userBalance.create).not.toHaveBeenCalled()
  })

  it('creates a zero balance when missing', async () => {
    prismaMock.userBalance.findUnique.mockResolvedValue(null)
    prismaMock.userBalance.create.mockResolvedValue(balanceRow(0))
    await expect(getBalance('u1')).resolves.toMatchObject({ balance: 0 })
    expect(prismaMock.userBalance.create).toHaveBeenCalled()
  })

  it('checkBalance compares against required amount', async () => {
    prismaMock.userBalance.findUnique.mockResolvedValue(balanceRow(5))
    await expect(checkBalance('u1', 5)).resolves.toBe(true)
    await expect(checkBalance('u1', 5.01)).resolves.toBe(false)
  })

  it('getFreezeByIdempotencyKey handles blank, missing and found', async () => {
    await expect(getFreezeByIdempotencyKey('  ')).resolves.toBeNull()
    expect(prismaMock.balanceFreeze.findUnique).not.toHaveBeenCalled()
    prismaMock.balanceFreeze.findUnique.mockResolvedValueOnce(null)
    await expect(getFreezeByIdempotencyKey('k')).resolves.toBeNull()
    prismaMock.balanceFreeze.findUnique.mockResolvedValueOnce({ id: 'f1', userId: 'u1', amount: 2, status: 'pending' })
    await expect(getFreezeByIdempotencyKey('k')).resolves.toEqual({ id: 'f1', userId: 'u1', amount: 2, status: 'pending' })
  })
})

describe('freezeBalance', () => {
  it.each([0, -1, Number.NaN])('rejects invalid amount %s', async (amount) => {
    await expect(freezeBalance('u1', amount)).resolves.toBeNull()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('returns existing freeze id for idempotency key', async () => {
    tx.balanceFreeze.findUnique.mockResolvedValue({ id: 'f-existing' })
    await expect(freezeBalance('u1', 1, { idempotencyKey: 'k' })).resolves.toBe('f-existing')
    expect(tx.userBalance.updateMany).not.toHaveBeenCalled()
  })

  it('creates missing balance row and returns null on insufficient funds', async () => {
    tx.userBalance.findUnique.mockResolvedValue(null)
    tx.userBalance.updateMany.mockResolvedValue({ count: 0 })
    await expect(freezeBalance('u1', 3)).resolves.toBeNull()
    expect(tx.userBalance.create).toHaveBeenCalled()
    expect(tx.balanceFreeze.create).not.toHaveBeenCalled()
  })

  it('freezes funds and records freeze with options', async () => {
    tx.balanceFreeze.findUnique.mockResolvedValue(null)
    tx.userBalance.findUnique.mockResolvedValue(balanceRow())
    tx.userBalance.updateMany.mockResolvedValue({ count: 1 })
    const id = await freezeBalance('u1', 1.2345678, {
      source: 'task', taskId: 't1', requestId: 'r1', idempotencyKey: 'k', metadata: { a: 1 },
    })
    expect(id).toMatch(/^freeze_/)
    expect(tx.userBalance.updateMany.mock.calls[0][0].where.balance.gte).toBe(1.234568)
    expect(tx.balanceFreeze.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id, userId: 'u1', amount: 1.234568, status: 'pending', source: 'task', taskId: 't1',
        requestId: 'r1', idempotencyKey: 'k', metadata: JSON.stringify({ a: 1 }),
      }),
    })
  })

  it('defaults source/nullable fields', async () => {
    tx.userBalance.findUnique.mockResolvedValue(balanceRow())
    tx.userBalance.updateMany.mockResolvedValue({ count: 1 })
    await freezeBalance('u1', 1)
    expect(tx.balanceFreeze.create.mock.calls[0][0].data).toMatchObject({
      source: 'sync', taskId: null, requestId: null, idempotencyKey: null, metadata: null,
    })
  })

  it('recovers existing freeze on P2002 unique conflict', async () => {
    prismaMock.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    )
    prismaMock.balanceFreeze.findUnique.mockResolvedValue({ id: 'f-race' })
    await expect(freezeBalance('u1', 1, { idempotencyKey: 'k' })).resolves.toBe('f-race')
  })

  it('returns null on P2002 when no existing freeze, and on generic errors', async () => {
    prismaMock.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    )
    prismaMock.balanceFreeze.findUnique.mockResolvedValue(null)
    await expect(freezeBalance('u1', 1, { idempotencyKey: 'k' })).resolves.toBeNull()
    prismaMock.$transaction.mockRejectedValueOnce(new Error('db down'))
    await expect(freezeBalance('u1', 1)).resolves.toBeNull()
  })
})

describe('confirmChargeWithRecord', () => {
  const pending = { id: 'f1', userId: 'u1', amount: 5, status: 'pending' }

  it('throws BILLING_INVALID_FREEZE when freeze missing', async () => {
    tx.balanceFreeze.findUnique.mockResolvedValue(null)
    await expect(confirmChargeWithRecord('f1', recordParams)).rejects.toMatchObject({ code: 'BILLING_INVALID_FREEZE' })
  })

  it('is idempotent when already confirmed', async () => {
    tx.balanceFreeze.findUnique.mockResolvedValue({ ...pending, status: 'confirmed' })
    await expect(confirmChargeWithRecord('f1', recordParams)).resolves.toBe(true)
    expect(tx.userBalance.update).not.toHaveBeenCalled()
  })

  it('rejects non-pending freeze', async () => {
    tx.balanceFreeze.findUnique.mockResolvedValue({ ...pending, status: 'rolled_back' })
    await expect(confirmChargeWithRecord('f1', recordParams)).rejects.toMatchObject({ code: 'BILLING_FREEZE_NOT_PENDING' })
  })

  it.each([-1, 5.01])('rejects invalid chargedAmount %s', async (chargedAmount) => {
    tx.balanceFreeze.findUnique.mockResolvedValue(pending)
    await expect(confirmChargeWithRecord('f1', recordParams, { chargedAmount }))
      .rejects.toMatchObject({ code: 'BILLING_INVALID_CHARGED_AMOUNT' })
  })

  it('charges full amount by default and records usage', async () => {
    tx.balanceFreeze.findUnique.mockResolvedValue(pending)
    tx.balanceFreeze.updateMany.mockResolvedValue({ count: 1 })
    tx.userBalance.update.mockResolvedValue({ balance: 7 })
    await expect(confirmChargeWithRecord('f1', recordParams)).resolves.toBe(true)
    const data = tx.userBalance.update.mock.calls[0][0].data
    expect(data).toEqual({ frozenAmount: { decrement: 5 }, totalSpent: { increment: 5 } })
    expect(reportingMock.recordUsageCostOnly).toHaveBeenCalledWith(tx, expect.objectContaining({
      userId: 'u1', cost: 5, balanceAfter: 7, freezeId: 'f1',
    }))
  })

  it('partial charge refunds the difference', async () => {
    tx.balanceFreeze.findUnique.mockResolvedValue(pending)
    tx.balanceFreeze.updateMany.mockResolvedValue({ count: 1 })
    tx.userBalance.update.mockResolvedValue({ balance: 9 })
    await confirmChargeWithRecord('f1', recordParams, { chargedAmount: 2 })
    expect(tx.userBalance.update.mock.calls[0][0].data).toEqual({
      frozenAmount: { decrement: 5 }, totalSpent: { increment: 2 }, balance: { increment: 3 },
    })
  })

  it('zero charge refunds all and skips usage record', async () => {
    tx.balanceFreeze.findUnique.mockResolvedValue(pending)
    tx.balanceFreeze.updateMany.mockResolvedValue({ count: 1 })
    tx.userBalance.update.mockResolvedValue({ balance: 10 })
    await confirmChargeWithRecord('f1', recordParams, { chargedAmount: 0 })
    expect(reportingMock.recordUsageCostOnly).not.toHaveBeenCalled()
  })

  it('concurrent switch: succeeds if latest is confirmed, else throws', async () => {
    tx.balanceFreeze.updateMany.mockResolvedValue({ count: 0 })
    tx.balanceFreeze.findUnique.mockResolvedValueOnce(pending).mockResolvedValueOnce({ ...pending, status: 'confirmed' })
    await expect(confirmChargeWithRecord('f1', recordParams)).resolves.toBe(true)
    tx.balanceFreeze.findUnique.mockResolvedValueOnce(pending).mockResolvedValueOnce(null)
    await expect(confirmChargeWithRecord('f1', recordParams)).rejects.toMatchObject({ code: 'BILLING_FREEZE_NOT_PENDING' })
  })

  it('wraps unexpected errors as BILLING_CONFIRM_FAILED', async () => {
    prismaMock.$transaction.mockRejectedValueOnce(new Error('db down'))
    const err = await confirmChargeWithRecord('f1', recordParams).catch((e) => e)
    expect(err).toBeInstanceOf(BillingOperationError)
    expect(err.code).toBe('BILLING_CONFIRM_FAILED')
    prismaMock.$transaction.mockRejectedValueOnce('boom')
    await expect(confirmChargeWithRecord('f1', recordParams)).rejects.toMatchObject({ code: 'BILLING_CONFIRM_FAILED' })
  })
})

describe('rollbackFreeze', () => {
  const pending = { id: 'f1', userId: 'u1', amount: 4, status: 'pending' }

  it('returns false when freeze missing or not pending', async () => {
    tx.balanceFreeze.findUnique.mockResolvedValueOnce(null)
    await expect(rollbackFreeze('f1')).resolves.toBe(false)
    tx.balanceFreeze.findUnique.mockResolvedValueOnce({ ...pending, status: 'confirmed' })
    await expect(rollbackFreeze('f1')).resolves.toBe(false)
  })

  it('is idempotent for rolled_back', async () => {
    tx.balanceFreeze.findUnique.mockResolvedValue({ ...pending, status: 'rolled_back' })
    await expect(rollbackFreeze('f1')).resolves.toBe(true)
    expect(tx.userBalance.update).not.toHaveBeenCalled()
  })

  it('returns frozen funds to balance', async () => {
    tx.balanceFreeze.findUnique.mockResolvedValue(pending)
    tx.balanceFreeze.updateMany.mockResolvedValue({ count: 1 })
    await expect(rollbackFreeze('f1')).resolves.toBe(true)
    expect(tx.userBalance.update).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      data: { balance: { increment: 4 }, frozenAmount: { decrement: 4 } },
    })
  })

  it('concurrent switch: true if already rolled back, false otherwise', async () => {
    tx.balanceFreeze.updateMany.mockResolvedValue({ count: 0 })
    tx.balanceFreeze.findUnique.mockResolvedValueOnce(pending).mockResolvedValueOnce({ ...pending, status: 'rolled_back' })
    await expect(rollbackFreeze('f1')).resolves.toBe(true)
    tx.balanceFreeze.findUnique.mockResolvedValueOnce(pending).mockResolvedValueOnce({ ...pending, status: 'confirmed' })
    await expect(rollbackFreeze('f1')).resolves.toBe(false)
  })
})

describe('increasePendingFreezeAmount', () => {
  const pending = { id: 'f1', userId: 'u1', amount: 4, status: 'pending' }

  it('rejects negative / NaN delta and short-circuits zero', async () => {
    await expect(increasePendingFreezeAmount('f1', -1)).rejects.toMatchObject({ code: 'BILLING_INVALID_DELTA' })
    await expect(increasePendingFreezeAmount('f1', Number.NaN)).rejects.toMatchObject({ code: 'BILLING_INVALID_DELTA' })
    await expect(increasePendingFreezeAmount('f1', 0)).resolves.toBe(true)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('missing / confirmed / non-pending freeze', async () => {
    tx.balanceFreeze.findUnique.mockResolvedValueOnce(null)
    await expect(increasePendingFreezeAmount('f1', 1)).rejects.toMatchObject({ code: 'BILLING_INVALID_FREEZE' })
    tx.balanceFreeze.findUnique.mockResolvedValueOnce({ ...pending, status: 'confirmed' })
    await expect(increasePendingFreezeAmount('f1', 1)).resolves.toBe(true)
    tx.balanceFreeze.findUnique.mockResolvedValueOnce({ ...pending, status: 'rolled_back' })
    await expect(increasePendingFreezeAmount('f1', 1)).rejects.toMatchObject({ code: 'BILLING_FREEZE_NOT_PENDING' })
  })

  it('returns false on insufficient balance', async () => {
    tx.balanceFreeze.findUnique.mockResolvedValue(pending)
    tx.userBalance.updateMany.mockResolvedValue({ count: 0 })
    await expect(increasePendingFreezeAmount('f1', 1)).resolves.toBe(false)
    expect(tx.balanceFreeze.updateMany).not.toHaveBeenCalled()
  })

  it('expands freeze amount', async () => {
    tx.balanceFreeze.findUnique.mockResolvedValue(pending)
    tx.userBalance.updateMany.mockResolvedValue({ count: 1 })
    tx.balanceFreeze.updateMany.mockResolvedValue({ count: 1 })
    await expect(increasePendingFreezeAmount('f1', 1.5)).resolves.toBe(true)
    expect(tx.balanceFreeze.updateMany).toHaveBeenCalledWith({
      where: { id: 'f1', status: 'pending' }, data: { amount: { increment: 1.5 } },
    })
  })

  it('throws when freeze switched concurrently', async () => {
    tx.balanceFreeze.findUnique.mockResolvedValue(pending)
    tx.userBalance.updateMany.mockResolvedValue({ count: 1 })
    tx.balanceFreeze.updateMany.mockResolvedValue({ count: 0 })
    await expect(increasePendingFreezeAmount('f1', 1)).rejects.toMatchObject({ code: 'BILLING_FREEZE_NOT_PENDING' })
  })

  it('wraps unexpected errors as BILLING_FREEZE_EXPAND_FAILED', async () => {
    prismaMock.$transaction.mockRejectedValueOnce(new Error('db down'))
    await expect(increasePendingFreezeAmount('f1', 1)).rejects.toMatchObject({ code: 'BILLING_FREEZE_EXPAND_FAILED' })
    prismaMock.$transaction.mockRejectedValueOnce('boom')
    await expect(increasePendingFreezeAmount('f1', 1)).rejects.toMatchObject({ code: 'BILLING_FREEZE_EXPAND_FAILED' })
  })
})

describe('addBalance / recordShadowUsage branches', () => {
  it('skips duplicate idempotent adjust', async () => {
    tx.balanceTransaction.findFirst.mockResolvedValue({ id: 'tx1' })
    await expect(addBalance('u1', 3, { type: 'adjust', idempotencyKey: 'k', operatorId: 'op' })).resolves.toBe(true)
    expect(tx.balanceTransaction.findFirst.mock.calls[0][0].where.type).toBe('adjust')
    expect(tx.userBalance.upsert).not.toHaveBeenCalled()
  })

  it('records options-object recharge with defaults', async () => {
    tx.balanceTransaction.findFirst.mockResolvedValue(null)
    tx.userBalance.upsert.mockResolvedValue({ balance: 3 })
    await expect(addBalance('u1', 3, { externalOrderId: 'o1', idempotencyKey: 'k' })).resolves.toBe(true)
    expect(tx.balanceTransaction.create.mock.calls[0][0].data).toMatchObject({
      type: 'recharge', relatedId: 'o1', externalOrderId: 'o1', operatorId: null,
    })
    tx.userBalance.upsert.mockResolvedValue({ balance: 4 })
    await expect(addBalance('u1', 1)).resolves.toBe(true)
    expect(tx.balanceTransaction.create.mock.calls[1][0].data.description).toMatch(/^balance recharge/)
  })

  it('recordShadowUsage writes zero-amount shadow transaction, false on error', async () => {
    tx.userBalance.upsert.mockResolvedValue({ balance: 2 })
    const base = { projectId: '', action: 'a', apiType: 'image' as never, model: 'm', quantity: 1, unit: 'image' as never, cost: 1 }
    await expect(recordShadowUsage('u1', { ...base, metadata: { x: 1 } })).resolves.toBe(true)
    await expect(recordShadowUsage('u1', { ...base, action: '', taskType: 'tt', episodeId: 'e1' })).resolves.toBe(true)
    const [first, second] = tx.balanceTransaction.create.mock.calls.map((c) => c[0].data)
    expect(first).toMatchObject({ type: 'shadow_consume', amount: 0, projectId: null, taskType: 'a' })
    expect(first.description).toContain('{"x":1}')
    expect(second).toMatchObject({ taskType: 'tt', episodeId: 'e1' })
    prismaMock.$transaction.mockRejectedValueOnce(new Error('db'))
    await expect(recordShadowUsage('u1', base)).resolves.toBe(false)
  })
})
