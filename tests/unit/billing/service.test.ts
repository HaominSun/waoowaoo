import { beforeEach, describe, expect, it, vi } from 'vitest'
import { calcText, calcVideo, calcVoice } from '@/lib/billing/cost'
import type { TaskBillingInfo } from '@/lib/task/types'

const ledgerMock = vi.hoisted(() => ({
  confirmChargeWithRecord: vi.fn(),
  freezeBalance: vi.fn(),
  getBalance: vi.fn(),
  getFreezeByIdempotencyKey: vi.fn(),
  increasePendingFreezeAmount: vi.fn(),
  recordShadowUsage: vi.fn(),
  rollbackFreeze: vi.fn(),
}))

const modeMock = vi.hoisted(() => ({
  getBillingMode: vi.fn(),
}))

const entitlementsMock = vi.hoisted(() => ({
  assertOrganizationCanConsume: vi.fn(),
}))

const organizationBillingMock = vi.hoisted(() => ({
  confirmOrganizationCharge: vi.fn(),
  confirmOrganizationChargeWithRecord: vi.fn(),
  freezeOrganizationBalance: vi.fn(),
  getOrganizationBalance: vi.fn(),
  increaseOrganizationPendingFreezeAmount: vi.fn(),
  rollbackOrganizationFreeze: vi.fn(),
}))

const reportingMock = vi.hoisted(() => ({
  recordUsageCostOnly: vi.fn(),
}))

const creditLedgerMock = vi.hoisted(() => ({
  recordShadowCreditLedger: vi.fn(),
}))

vi.mock('@/lib/billing/ledger', () => ledgerMock)
vi.mock('@/lib/billing/mode', () => modeMock)
vi.mock('@/lib/saas/entitlements', () => entitlementsMock)
vi.mock('@/lib/billing/organization', () => organizationBillingMock)
vi.mock('@/lib/billing/reporting', () => reportingMock)
vi.mock('@/lib/billing/credit-ledger', () => creditLedgerMock)

import { BillingOperationError, InsufficientBalanceError } from '@/lib/billing/errors'
import {
  handleBillingError,
  prepareTaskBilling,
  rollbackTaskBilling,
  settleTaskBilling,
  withTextBilling,
  withVoiceBilling,
} from '@/lib/billing/service'

describe('billing/service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ledgerMock.confirmChargeWithRecord.mockResolvedValue(true)
    ledgerMock.freezeBalance.mockResolvedValue('freeze_1')
    ledgerMock.getBalance.mockResolvedValue({ balance: 0 })
    ledgerMock.getFreezeByIdempotencyKey.mockResolvedValue(null)
    ledgerMock.increasePendingFreezeAmount.mockResolvedValue(true)
    ledgerMock.recordShadowUsage.mockResolvedValue(true)
    ledgerMock.rollbackFreeze.mockResolvedValue(true)
    entitlementsMock.assertOrganizationCanConsume.mockResolvedValue(null)
    organizationBillingMock.confirmOrganizationCharge.mockResolvedValue(true)
    organizationBillingMock.confirmOrganizationChargeWithRecord.mockResolvedValue(true)
    organizationBillingMock.freezeOrganizationBalance.mockResolvedValue('org_freeze_1')
    organizationBillingMock.getOrganizationBalance.mockResolvedValue({
      id: 'org_balance_1',
      organizationId: 'org_1',
      balance: 10,
      frozenAmount: 0,
      totalSpent: 0,
    })
    organizationBillingMock.increaseOrganizationPendingFreezeAmount.mockResolvedValue(true)
    organizationBillingMock.rollbackOrganizationFreeze.mockResolvedValue(true)
    reportingMock.recordUsageCostOnly.mockResolvedValue(undefined)
    creditLedgerMock.recordShadowCreditLedger.mockResolvedValue(undefined)
  })

  it('returns raw execution result in OFF mode', async () => {
    modeMock.getBillingMode.mockResolvedValue('OFF')

    const result = await withTextBilling(
      'u1',
      'anthropic/claude-sonnet-4',
      1000,
      1000,
      { projectId: 'p1', action: 'a1' },
      async () => ({ ok: true }),
    )

    expect(result).toEqual({ ok: true })
    expect(ledgerMock.freezeBalance).not.toHaveBeenCalled()
    expect(ledgerMock.confirmChargeWithRecord).not.toHaveBeenCalled()
  })

  it('records shadow usage in SHADOW mode without freezing', async () => {
    modeMock.getBillingMode.mockResolvedValue('SHADOW')

    const result = await withTextBilling(
      'u1',
      'anthropic/claude-sonnet-4',
      1000,
      1000,
      { projectId: 'p1', action: 'a1' },
      async () => ({ ok: true }),
    )

    expect(result).toEqual({ ok: true })
    expect(ledgerMock.freezeBalance).not.toHaveBeenCalled()
    expect(ledgerMock.recordShadowUsage).toHaveBeenCalledTimes(1)
  })

  it('throws InsufficientBalanceError when ENFORCE freeze fails', async () => {
    modeMock.getBillingMode.mockResolvedValue('ENFORCE')
    ledgerMock.freezeBalance.mockResolvedValue(null)
    ledgerMock.getBalance.mockResolvedValue({ balance: 0.01 })

    await expect(
      withTextBilling(
        'u1',
        'anthropic/claude-sonnet-4',
        1000,
        1000,
        { projectId: 'p1', action: 'a1' },
        async () => ({ ok: true }),
      ),
    ).rejects.toBeInstanceOf(InsufficientBalanceError)
  })

  it('rolls back freeze when execution throws', async () => {
    modeMock.getBillingMode.mockResolvedValue('ENFORCE')
    ledgerMock.freezeBalance.mockResolvedValue('freeze_rollback')

    await expect(
      withTextBilling(
        'u1',
        'anthropic/claude-sonnet-4',
        1000,
        1000,
        { projectId: 'p1', action: 'a1' },
        async () => {
          throw new Error('boom')
        },
      ),
    ).rejects.toThrow('boom')

    expect(ledgerMock.rollbackFreeze).toHaveBeenCalledWith('freeze_rollback')
  })

  it('expands freeze and charges actual voice usage when actual exceeds quoted', async () => {
    modeMock.getBillingMode.mockResolvedValue('ENFORCE')
    ledgerMock.freezeBalance.mockResolvedValue('freeze_voice')

    await withVoiceBilling(
      'u1',
      5,
      { projectId: 'p1', action: 'voice_gen' },
      async () => ({ actualDurationSeconds: 50 }),
    )

    const confirmCall = ledgerMock.confirmChargeWithRecord.mock.calls.at(-1)
    expect(confirmCall).toBeTruthy()
    const chargedAmount = confirmCall?.[2]?.chargedAmount as number
    expect(ledgerMock.increasePendingFreezeAmount).toHaveBeenCalledTimes(1)
    expect(chargedAmount).toBeCloseTo(calcVoice(50), 8)
  })

  it('fails and rolls back when overage freeze expansion cannot be covered', async () => {
    modeMock.getBillingMode.mockResolvedValue('ENFORCE')
    ledgerMock.freezeBalance.mockResolvedValue('freeze_voice_low_balance')
    ledgerMock.increasePendingFreezeAmount.mockResolvedValue(false)
    ledgerMock.getBalance.mockResolvedValue({ balance: 0.001 })

    await expect(
      withVoiceBilling(
        'u1',
        5,
        { projectId: 'p1', action: 'voice_gen' },
        async () => ({ actualDurationSeconds: 50 }),
      ),
    ).rejects.toBeInstanceOf(InsufficientBalanceError)

    expect(ledgerMock.rollbackFreeze).toHaveBeenCalledWith('freeze_voice_low_balance')
  })

  it('rejects duplicate sync billing key when freeze is already confirmed', async () => {
    modeMock.getBillingMode.mockResolvedValue('ENFORCE')
    ledgerMock.getFreezeByIdempotencyKey.mockResolvedValue({
      id: 'freeze_confirmed',
      userId: 'u1',
      amount: 0.5,
      status: 'confirmed',
    })
    const execute = vi.fn(async () => ({ ok: true }))

    await expect(
      withTextBilling(
        'u1',
        'anthropic/claude-sonnet-4',
        1000,
        1000,
        { projectId: 'p1', action: 'a1', billingKey: 'billing-key-1' },
        execute,
      ),
    ).rejects.toThrow('duplicate billing request already confirmed')

    expect(execute).not.toHaveBeenCalled()
    expect(ledgerMock.freezeBalance).not.toHaveBeenCalled()
  })

  it('rejects duplicate sync billing key when freeze is pending', async () => {
    modeMock.getBillingMode.mockResolvedValue('ENFORCE')
    ledgerMock.getFreezeByIdempotencyKey.mockResolvedValue({
      id: 'freeze_pending',
      userId: 'u1',
      amount: 0.5,
      status: 'pending',
    })
    const execute = vi.fn(async () => ({ ok: true }))

    await expect(
      withTextBilling(
        'u1',
        'anthropic/claude-sonnet-4',
        1000,
        1000,
        { projectId: 'p1', action: 'a1', billingKey: 'billing-key-2' },
        execute,
      ),
    ).rejects.toThrow('duplicate billing request is already in progress')

    expect(execute).not.toHaveBeenCalled()
    expect(ledgerMock.freezeBalance).not.toHaveBeenCalled()
  })

  it('maps insufficient balance error to 402 response payload', async () => {
    const response = handleBillingError(new InsufficientBalanceError(1.2, 0.3))
    expect(response).toBeTruthy()
    expect(response?.status).toBe(402)
    const body = await response?.json()
    expect(body?.code).toBe('INSUFFICIENT_BALANCE')
    expect(body?.required).toBeCloseTo(1.2, 8)
    expect(body?.available).toBeCloseTo(0.3, 8)
  })

  it('returns null for non-billing errors', () => {
    expect(handleBillingError(new Error('x'))).toBeNull()
    expect(handleBillingError('x')).toBeNull()
  })

  describe('task billing lifecycle helpers', () => {
    function buildTaskInfo(overrides: Partial<Extract<TaskBillingInfo, { billable: true }>> = {}): Extract<TaskBillingInfo, { billable: true }> {
      return {
        billable: true,
        source: 'task',
        taskType: 'voice_line',
        apiType: 'voice',
        model: 'index-tts2',
        quantity: 5,
        unit: 'second',
        maxFrozenCost: calcVoice(5),
        action: 'voice_line_generate',
        metadata: { foo: 'bar' },
        ...overrides,
      }
    }

    function buildSeedance2VideoTaskInfo(
      overrides: Partial<Extract<TaskBillingInfo, { billable: true }>> = {},
    ): Extract<TaskBillingInfo, { billable: true }> {
      return {
        billable: true,
        source: 'task',
        taskType: 'video_panel',
        apiType: 'video',
        model: 'doubao-seedance-2-0-260128',
        quantity: 1,
        unit: 'video',
        maxFrozenCost: calcVideo('doubao-seedance-2-0-260128', '720p', 1, {
          resolution: '720p',
          duration: 5,
          aspectRatio: '16:9',
          containsVideoInput: false,
        }),
        action: 'video_panel_generate',
        metadata: {
          resolution: '720p',
          duration: 5,
          aspectRatio: '16:9',
          containsVideoInput: false,
        },
        ...overrides,
      }
    }

    it('prepareTaskBilling handles OFF/SHADOW/ENFORCE paths', async () => {
      modeMock.getBillingMode.mockResolvedValueOnce('OFF')
      const off = await prepareTaskBilling({
        id: 'task_off',
        userId: 'u1',
        projectId: 'p1',
        billingInfo: buildTaskInfo(),
      })
      expect((off as Extract<TaskBillingInfo, { billable: true }>).status).toBe('skipped')

      modeMock.getBillingMode.mockResolvedValueOnce('SHADOW')
      const shadow = await prepareTaskBilling({
        id: 'task_shadow',
        userId: 'u1',
        projectId: 'p1',
        billingInfo: buildTaskInfo(),
      })
      expect((shadow as Extract<TaskBillingInfo, { billable: true }>).status).toBe('quoted')

      modeMock.getBillingMode.mockResolvedValueOnce('ENFORCE')
      ledgerMock.freezeBalance.mockResolvedValueOnce('freeze_task_1')
      const enforce = await prepareTaskBilling({
        id: 'task_enforce',
        userId: 'u1',
        projectId: 'p1',
        billingInfo: buildTaskInfo(),
      })
      const enforceInfo = enforce as Extract<TaskBillingInfo, { billable: true }>
      expect(enforceInfo.status).toBe('frozen')
      expect(enforceInfo.freezeId).toBe('freeze_task_1')
      expect(creditLedgerMock.recordShadowCreditLedger).toHaveBeenCalledTimes(1)
      expect(creditLedgerMock.recordShadowCreditLedger).toHaveBeenCalledWith(expect.objectContaining({
        mode: 'SHADOW',
        phase: 'prepare',
        taskId: 'task_shadow',
      }))
    })

    it('prepareTaskBilling tolerates unknown text model pricing in SHADOW mode', async () => {
      modeMock.getBillingMode.mockResolvedValueOnce('SHADOW')
      const unknownTextInfo = buildTaskInfo({
        taskType: 'story_to_script_run',
        apiType: 'text',
        model: 'gpt-5.2',
        quantity: 2400,
        unit: 'token',
        maxFrozenCost: 0,
        action: 'story_to_script_run',
      })

      const shadow = await prepareTaskBilling({
        id: 'task_shadow_unknown_text_model',
        userId: 'u1',
        projectId: 'p1',
        billingInfo: unknownTextInfo,
      })

      const shadowInfo = shadow as Extract<TaskBillingInfo, { billable: true }>
      expect(shadowInfo.status).toBe('skipped')
      expect(shadowInfo.maxFrozenCost).toBe(0)
      expect(creditLedgerMock.recordShadowCreditLedger).not.toHaveBeenCalled()
    })

    it('prepareTaskBilling throws InsufficientBalanceError when ENFORCE freeze fails', async () => {
      modeMock.getBillingMode.mockResolvedValue('ENFORCE')
      ledgerMock.freezeBalance.mockResolvedValue(null)
      ledgerMock.getBalance.mockResolvedValue({ balance: 0.001 })

      await expect(
        prepareTaskBilling({
          id: 'task_no_balance',
          userId: 'u1',
          projectId: 'p1',
          billingInfo: buildTaskInfo(),
        }),
      ).rejects.toBeInstanceOf(InsufficientBalanceError)
    })

    it('prepareTaskBilling freezes organization balance instead of personal balance for organization tasks', async () => {
      modeMock.getBillingMode.mockResolvedValue('ENFORCE')
      entitlementsMock.assertOrganizationCanConsume.mockResolvedValue({
        organizationId: 'org_1',
        planCreditApplied: 0,
        balanceChargeApplied: calcVoice(5),
      })

      const prepared = await prepareTaskBilling({
        id: 'task_org_enforce',
        userId: 'u1',
        projectId: 'project_org',
        billingInfo: buildTaskInfo(),
      })

      const info = prepared as Extract<TaskBillingInfo, { billable: true }>
      expect(info.status).toBe('frozen')
      expect(info.organizationId).toBe('org_1')
      expect(info.freezeScope).toBe('organization')
      expect(info.freezeId).toBe('org_freeze_1')
      expect(organizationBillingMock.freezeOrganizationBalance).toHaveBeenCalledWith(
        'org_1',
        calcVoice(5),
        expect.objectContaining({
          taskId: 'task_org_enforce',
          userId: 'u1',
          idempotencyKey: 'task_org_enforce',
        }),
      )
      expect(ledgerMock.freezeBalance).not.toHaveBeenCalled()
      expect(creditLedgerMock.recordShadowCreditLedger).not.toHaveBeenCalled()
    })

    it('prepareTaskBilling quotes organization tasks in SHADOW without freezing or moving balance', async () => {
      modeMock.getBillingMode.mockResolvedValue('SHADOW')
      entitlementsMock.assertOrganizationCanConsume.mockResolvedValue({
        organizationId: 'org_1',
        planCreditApplied: 4,
        balanceChargeApplied: 6,
      })

      const prepared = await prepareTaskBilling({
        id: 'task_org_shadow',
        userId: 'u1',
        projectId: 'project_org',
        billingInfo: buildTaskInfo({ maxFrozenCost: 10 }),
      })

      const info = prepared as Extract<TaskBillingInfo, { billable: true }>
      expect(info.status).toBe('quoted')
      expect(info.organizationId).toBe('org_1')
      expect(organizationBillingMock.freezeOrganizationBalance).not.toHaveBeenCalled()
      expect(ledgerMock.freezeBalance).not.toHaveBeenCalled()
      expect(creditLedgerMock.recordShadowCreditLedger).toHaveBeenCalledWith(expect.objectContaining({
        mode: 'SHADOW',
        phase: 'prepare',
        taskId: 'task_org_shadow',
        organizationId: 'org_1',
        estimatedAmount: 10,
        planCreditPortion: 4,
        balancePortion: 6,
      }))
    })

    it.each([
      {
        name: 'no balance charge',
        policy: { organizationId: 'org_1', planCreditApplied: 10, balanceChargeApplied: 0 },
        planCreditPortion: 10,
        balancePortion: 0,
      },
      {
        name: 'partial plan with the balance charge omitted',
        policy: { organizationId: 'org_1', planCreditApplied: 4 },
        planCreditPortion: 4,
        balancePortion: 6,
      },
      {
        name: 'full balance charge',
        policy: { organizationId: 'org_1', planCreditApplied: 0, balanceChargeApplied: 10 },
        planCreditPortion: 0,
        balancePortion: 10,
      },
    ])('prepareTaskBilling shadow portions stay inside the quote for $name', async ({ policy, planCreditPortion, balancePortion }) => {
      modeMock.getBillingMode.mockResolvedValue('SHADOW')
      entitlementsMock.assertOrganizationCanConsume.mockResolvedValue(policy)

      await prepareTaskBilling({
        id: 'task_portion_shadow',
        userId: 'u1',
        projectId: 'project_org',
        billingInfo: buildTaskInfo({ maxFrozenCost: 10 }),
      })

      expect(creditLedgerMock.recordShadowCreditLedger).toHaveBeenCalledWith(expect.objectContaining({
        estimatedAmount: 10,
        planCreditPortion,
        balancePortion,
      }))
    })

    it('prepareTaskBilling creates a zero-balance organization reservation when plan credit covers the estimate', async () => {
      modeMock.getBillingMode.mockResolvedValue('ENFORCE')
      entitlementsMock.assertOrganizationCanConsume.mockResolvedValue({
        organizationId: 'org_1',
        planCreditApplied: calcVoice(5),
        balanceChargeApplied: 0,
      })
      organizationBillingMock.freezeOrganizationBalance.mockResolvedValueOnce('org_reservation_1')

      const prepared = await prepareTaskBilling({
        id: 'task_org_plan_credit_prepare',
        userId: 'u1',
        projectId: 'project_org',
        billingInfo: buildTaskInfo(),
      })

      const info = prepared as Extract<TaskBillingInfo, { billable: true }>
      expect(info.status).toBe('frozen')
      expect(info.freezeScope).toBe('organization')
      expect(info.freezeId).toBe('org_reservation_1')
      expect(organizationBillingMock.freezeOrganizationBalance).toHaveBeenCalledWith(
        'org_1',
        0,
        expect.objectContaining({
          taskId: 'task_org_plan_credit_prepare',
          userId: 'u1',
          planCreditAmount: calcVoice(5),
        }),
      )
      expect(ledgerMock.freezeBalance).not.toHaveBeenCalled()
    })

    it('settleTaskBilling handles SHADOW and non-ENFORCE snapshots', async () => {
      const shadowSettled = await settleTaskBilling({
        id: 'task_shadow_settle',
        userId: 'u1',
        projectId: 'p1',
        billingInfo: buildTaskInfo({ modeSnapshot: 'SHADOW', status: 'quoted' }),
      })
      const shadowInfo = shadowSettled as Extract<TaskBillingInfo, { billable: true }>
      expect(shadowInfo.status).toBe('settled')
      expect(shadowInfo.chargedCost).toBe(0)
      expect(ledgerMock.recordShadowUsage).toHaveBeenCalled()
      expect(creditLedgerMock.recordShadowCreditLedger).toHaveBeenCalledTimes(1)
      expect(creditLedgerMock.recordShadowCreditLedger).toHaveBeenCalledWith(expect.objectContaining({
        mode: 'SHADOW',
        phase: 'settle',
        taskId: 'task_shadow_settle',
        planCreditPortion: 0,
        balancePortion: expect.any(Number),
      }))
      const settledCall = creditLedgerMock.recordShadowCreditLedger.mock.calls.at(-1)?.[0] as {
        actualAmount: number
        planCreditPortion: number
        balancePortion: number
      }
      expect(settledCall.planCreditPortion + settledCall.balancePortion).toBeCloseTo(settledCall.actualAmount, 6)

      const offSettled = await settleTaskBilling({
        id: 'task_off_settle',
        userId: 'u1',
        projectId: 'p1',
        billingInfo: buildTaskInfo({ modeSnapshot: 'OFF', status: 'quoted' }),
      })
      const offInfo = offSettled as Extract<TaskBillingInfo, { billable: true }>
      expect(offInfo.status).toBe('settled')
      expect(offInfo.chargedCost).toBe(0)
      expect(creditLedgerMock.recordShadowCreditLedger).toHaveBeenCalledTimes(1)
      expect(creditLedgerMock.recordShadowCreditLedger).toHaveBeenCalledWith(expect.objectContaining({
        taskId: 'task_shadow_settle',
      }))
    })

    it('settleTaskBilling keeps shadow portions inside the actual cost when plan credit is partial', async () => {
      const settled = await settleTaskBilling({
        id: 'task_shadow_partial',
        userId: 'u1',
        projectId: 'p1',
        billingInfo: buildTaskInfo({
          modeSnapshot: 'SHADOW',
          status: 'quoted',
          maxFrozenCost: 10,
          planCreditApplied: 4,
        }),
      })
      expect((settled as Extract<TaskBillingInfo, { billable: true }>).chargedCost).toBe(0)
      expect(creditLedgerMock.recordShadowCreditLedger).toHaveBeenCalledWith(expect.objectContaining({
        phase: 'settle',
        actualAmount: 10,
        planCreditPortion: 4,
        balancePortion: 6,
      }))
    })

    it('settleTaskBilling does not fail OFF snapshot when text usage model pricing is unknown', async () => {
      const settled = await settleTaskBilling({
        id: 'task_off_unknown_usage_model',
        userId: 'u1',
        projectId: 'p1',
        billingInfo: buildTaskInfo({
          taskType: 'story_to_script_run',
          apiType: 'text',
          model: 'gpt-5.2',
          quantity: 2400,
          unit: 'token',
          maxFrozenCost: 0,
          action: 'story_to_script_run',
          modeSnapshot: 'OFF',
          status: 'quoted',
        }),
      }, {
        textUsage: [{ model: 'gpt-5.2', inputTokens: 1200, outputTokens: 800 }],
      })

      const settledInfo = settled as Extract<TaskBillingInfo, { billable: true }>
      expect(settledInfo.status).toBe('settled')
      expect(settledInfo.chargedCost).toBe(0)
      expect(ledgerMock.recordShadowUsage).not.toHaveBeenCalled()
    })

    it('settleTaskBilling skips SHADOW settlement when text model pricing is unknown', async () => {
      const settled = await settleTaskBilling({
        id: 'task_shadow_unknown_usage_model',
        userId: 'u1',
        projectId: 'p1',
        billingInfo: buildTaskInfo({
          taskType: 'story_to_script_run',
          apiType: 'text',
          model: 'gpt-5.2',
          quantity: 2400,
          unit: 'token',
          maxFrozenCost: 0,
          action: 'story_to_script_run',
          modeSnapshot: 'SHADOW',
          status: 'quoted',
        }),
      }, {
        textUsage: [{ model: 'gpt-5.2', inputTokens: 1200, outputTokens: 800 }],
      })

      const settledInfo = settled as Extract<TaskBillingInfo, { billable: true }>
      expect(settledInfo.status).toBe('settled')
      expect(settledInfo.chargedCost).toBe(0)
      expect(ledgerMock.recordShadowUsage).not.toHaveBeenCalled()
    })

    it('settleTaskBilling handles ENFORCE success/failure branches', async () => {
      ledgerMock.confirmChargeWithRecord.mockResolvedValueOnce(true)
      const settled = await settleTaskBilling({
        id: 'task_enforce_settle',
        userId: 'u1',
        projectId: 'p1',
        billingInfo: buildTaskInfo({ modeSnapshot: 'ENFORCE', freezeId: 'freeze_ok' }),
      })
      expect((settled as Extract<TaskBillingInfo, { billable: true }>).status).toBe('settled')

      const missingFreeze = await settleTaskBilling({
        id: 'task_enforce_no_freeze',
        userId: 'u1',
        projectId: 'p1',
        billingInfo: buildTaskInfo({ modeSnapshot: 'ENFORCE', freezeId: null }),
      })
      expect((missingFreeze as Extract<TaskBillingInfo, { billable: true }>).status).toBe('failed')

      ledgerMock.confirmChargeWithRecord.mockRejectedValueOnce(new Error('confirm failed'))
      await expect(
        settleTaskBilling({
          id: 'task_enforce_confirm_fail',
          userId: 'u1',
          projectId: 'p1',
          billingInfo: buildTaskInfo({ modeSnapshot: 'ENFORCE', freezeId: 'freeze_fail' }),
        }),
      ).rejects.toThrow('confirm failed')
    })

    it('settleTaskBilling confirms organization freeze and records organization usage without personal ledger confirmation', async () => {
      const settled = await settleTaskBilling({
        id: 'task_org_settle',
        userId: 'u1',
        projectId: 'project_org',
        billingInfo: buildTaskInfo({
          organizationId: 'org_1',
          planCreditApplied: 0,
          balanceChargeApplied: calcVoice(5),
          modeSnapshot: 'ENFORCE',
          freezeScope: 'organization',
          freezeId: 'org_freeze_1',
        }),
      })

      const info = settled as Extract<TaskBillingInfo, { billable: true }>
      expect(info.status).toBe('settled')
      expect(info.chargedCost).toBeCloseTo(calcVoice(5), 8)
      expect(organizationBillingMock.confirmOrganizationChargeWithRecord).toHaveBeenCalledWith(
        'org_freeze_1',
        calcVoice(5),
        expect.objectContaining({
          projectId: 'project_org',
          userId: 'u1',
          organizationId: 'org_1',
          cost: calcVoice(5),
          balanceAmount: calcVoice(5),
          metadata: expect.objectContaining({
            organizationChargedBalanceAmount: calcVoice(5),
          }),
        }),
      )
      expect(ledgerMock.confirmChargeWithRecord).not.toHaveBeenCalled()
      expect(reportingMock.recordUsageCostOnly).not.toHaveBeenCalled()
    })

    it('settleTaskBilling confirms plan-credit-only organization usage through a zero-balance reservation', async () => {
      const settled = await settleTaskBilling({
        id: 'task_org_plan_credit',
        userId: 'u1',
        projectId: 'project_org',
        billingInfo: buildTaskInfo({
          organizationId: 'org_1',
          planCreditApplied: calcVoice(5),
          balanceChargeApplied: 0,
          modeSnapshot: 'ENFORCE',
          freezeScope: 'organization',
          freezeId: 'org_reservation_1',
        }),
      })

      const info = settled as Extract<TaskBillingInfo, { billable: true }>
      expect(info.status).toBe('settled')
      expect(info.chargedCost).toBeCloseTo(calcVoice(5), 8)
      expect(organizationBillingMock.confirmOrganizationChargeWithRecord).toHaveBeenCalledWith(
        'org_reservation_1',
        0,
        expect.objectContaining({
          projectId: 'project_org',
          userId: 'u1',
          organizationId: 'org_1',
          cost: calcVoice(5),
          planCreditAmount: calcVoice(5),
          balanceAmount: 0,
        }),
      )
      expect(ledgerMock.confirmChargeWithRecord).not.toHaveBeenCalled()
      expect(reportingMock.recordUsageCostOnly).not.toHaveBeenCalled()
    })

    it('settleTaskBilling expands a zero-balance organization reservation when actual usage exceeds plan credit', async () => {
      const quoted = calcVoice(5)
      const actual = calcVoice(50)

      const settled = await settleTaskBilling({
        id: 'task_org_plan_credit_overage',
        userId: 'u1',
        projectId: 'project_org',
        billingInfo: buildTaskInfo({
          organizationId: 'org_1',
          planCreditApplied: quoted,
          balanceChargeApplied: 0,
          modeSnapshot: 'ENFORCE',
          freezeScope: 'organization',
          freezeId: 'org_reservation_overage',
        }),
      }, {
        result: { actualDurationSeconds: 50 },
      })

      const info = settled as Extract<TaskBillingInfo, { billable: true }>
      expect(info.status).toBe('settled')
      expect(info.chargedCost).toBeCloseTo(actual, 8)
      expect(organizationBillingMock.increaseOrganizationPendingFreezeAmount).toHaveBeenCalledWith(
        'org_reservation_overage',
        expect.closeTo(actual - quoted, 8),
      )
      expect(organizationBillingMock.confirmOrganizationChargeWithRecord).toHaveBeenCalledWith(
        'org_reservation_overage',
        expect.closeTo(actual - quoted, 8),
        expect.objectContaining({
          balanceAmount: expect.closeTo(actual - quoted, 8),
          planCreditAmount: quoted,
        }),
      )
      expect(ledgerMock.confirmChargeWithRecord).not.toHaveBeenCalled()
    })

    it('settleTaskBilling throws BILLING_CONFIRM_FAILED when confirm and rollback both fail', async () => {
      ledgerMock.confirmChargeWithRecord.mockRejectedValueOnce(new Error('confirm failed'))
      ledgerMock.rollbackFreeze.mockRejectedValueOnce(new Error('rollback failed'))

      await expect(
        settleTaskBilling({
          id: 'task_confirm_and_rollback_fail',
          userId: 'u1',
          projectId: 'p1',
          billingInfo: buildTaskInfo({ modeSnapshot: 'ENFORCE', freezeId: 'freeze_rb_fail_confirm' }),
        }),
      ).rejects.toMatchObject({
        name: 'BillingOperationError',
        code: 'BILLING_CONFIRM_FAILED',
      })
    })

    it('settleTaskBilling rethrows BillingOperationError with task context when rollback succeeds', async () => {
      ledgerMock.confirmChargeWithRecord.mockRejectedValueOnce(
        new BillingOperationError(
          'BILLING_INVALID_FREEZE',
          'invalid freeze',
          { reason: 'status_mismatch' },
        ),
      )

      let thrown: unknown = null
      try {
        await settleTaskBilling({
          id: 'task_confirm_billing_error',
          userId: 'u1',
          projectId: 'p1',
          billingInfo: buildTaskInfo({ modeSnapshot: 'ENFORCE', freezeId: 'freeze_billing_error' }),
        })
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(BillingOperationError)
      const billingError = thrown as BillingOperationError
      expect(billingError.code).toBe('BILLING_INVALID_FREEZE')
      expect(billingError.details).toMatchObject({
        reason: 'status_mismatch',
        taskId: 'task_confirm_billing_error',
        freezeId: 'freeze_billing_error',
      })
    })

    it('settleTaskBilling expands freeze when actual exceeds quoted', async () => {
      ledgerMock.confirmChargeWithRecord.mockResolvedValueOnce(true)
      const settled = await settleTaskBilling({
        id: 'task_enforce_overage',
        userId: 'u1',
        projectId: 'p1',
        billingInfo: buildTaskInfo({ modeSnapshot: 'ENFORCE', freezeId: 'freeze_overage', quantity: 5 }),
      }, {
        result: { actualDurationSeconds: 50 },
      })
      expect(ledgerMock.increasePendingFreezeAmount).toHaveBeenCalledTimes(1)
      expect(ledgerMock.confirmChargeWithRecord).toHaveBeenCalled()
      expect((settled as Extract<TaskBillingInfo, { billable: true }>).chargedCost).toBeCloseTo(calcVoice(50), 8)
    })

    it('settleTaskBilling charges Seedance 2.0 videos from exact usage tokens', async () => {
      ledgerMock.confirmChargeWithRecord.mockResolvedValueOnce(true)

      const settled = await settleTaskBilling({
        id: 'task_seedance2_actual_tokens',
        userId: 'u1',
        projectId: 'p1',
        billingInfo: buildSeedance2VideoTaskInfo({
          modeSnapshot: 'ENFORCE',
          freezeId: 'freeze_seedance2_actual_tokens',
        }),
      }, {
        result: { actualVideoTokens: 120_000 },
      })

      expect(ledgerMock.increasePendingFreezeAmount).toHaveBeenCalledTimes(1)
      expect((settled as Extract<TaskBillingInfo, { billable: true }>).chargedCost).toBeCloseTo(5.52, 8)
    })

    it('settleTaskBilling keeps quoted charge when text usage has no token counts', async () => {
      const quoted = calcText('anthropic/claude-sonnet-4', 500, 500)
      const textBillingInfo: Extract<TaskBillingInfo, { billable: true }> = {
        billable: true,
        source: 'task',
        taskType: 'analyze_novel',
        apiType: 'text',
        model: 'anthropic/claude-sonnet-4',
        quantity: 1000,
        unit: 'token',
        maxFrozenCost: quoted,
        action: 'analyze_novel',
        modeSnapshot: 'ENFORCE',
        status: 'frozen',
        freezeId: 'freeze_text_zero',
      }
      ledgerMock.confirmChargeWithRecord.mockResolvedValueOnce(true)

      const settled = await settleTaskBilling({
        id: 'task_text_zero_usage',
        userId: 'u1',
        projectId: 'p1',
        billingInfo: textBillingInfo,
      }, {
        textUsage: [{ model: 'openai/gpt-5', inputTokens: 0, outputTokens: 0 }],
      })

      expect((settled as Extract<TaskBillingInfo, { billable: true }>).chargedCost).toBeCloseTo(quoted, 8)
      const recordParams = ledgerMock.confirmChargeWithRecord.mock.calls.at(-1)?.[1] as { model: string }
      expect(recordParams.model).toBe('openai/gpt-5')
      expect(creditLedgerMock.recordShadowCreditLedger).not.toHaveBeenCalled()
    })

    it('rollbackTaskBilling handles success and fallback branches', async () => {
      const rolledBack = await rollbackTaskBilling({
        id: 'task_rb_ok',
        billingInfo: buildTaskInfo({ modeSnapshot: 'ENFORCE', freezeId: 'freeze_rb_ok' }),
      })
      expect((rolledBack as Extract<TaskBillingInfo, { billable: true }>).status).toBe('rolled_back')
      expect(creditLedgerMock.recordShadowCreditLedger).not.toHaveBeenCalled()

      ledgerMock.rollbackFreeze.mockRejectedValueOnce(new Error('rollback failed'))
      const rollbackFailed = await rollbackTaskBilling({
        id: 'task_rb_fail',
        billingInfo: buildTaskInfo({ modeSnapshot: 'ENFORCE', freezeId: 'freeze_rb_fail' }),
      })
      expect((rollbackFailed as Extract<TaskBillingInfo, { billable: true }>).status).toBe('failed')
    })

    it('rollbackTaskBilling rolls back organization freezes with organization billing service', async () => {
      const rolledBack = await rollbackTaskBilling({
        id: 'task_org_rb_ok',
        billingInfo: buildTaskInfo({
          organizationId: 'org_1',
          freezeScope: 'organization',
          modeSnapshot: 'ENFORCE',
          freezeId: 'org_freeze_rb_ok',
        }),
      })

      expect((rolledBack as Extract<TaskBillingInfo, { billable: true }>).status).toBe('rolled_back')
      expect(organizationBillingMock.rollbackOrganizationFreeze).toHaveBeenCalledWith('org_freeze_rb_ok')
      expect(ledgerMock.rollbackFreeze).not.toHaveBeenCalled()
    })

    it('rollbackTaskBilling records a shadow ledger row without moving a balance', async () => {
      const info = buildTaskInfo({ modeSnapshot: 'SHADOW', status: 'quoted' })
      const rolled = await rollbackTaskBilling({
        id: 'task_shadow_rb',
        billingInfo: info,
      })

      expect(rolled).toMatchObject({ status: 'quoted', modeSnapshot: 'SHADOW' })
      expect(creditLedgerMock.recordShadowCreditLedger).toHaveBeenCalledWith(expect.objectContaining({
        mode: 'SHADOW',
        phase: 'rollback',
        taskId: 'task_shadow_rb',
      }))
      expect(ledgerMock.rollbackFreeze).not.toHaveBeenCalled()
      expect(organizationBillingMock.rollbackOrganizationFreeze).not.toHaveBeenCalled()
    })
  })
})
