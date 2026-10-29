import { prisma } from '@/lib/prisma'

const BLOCKED_BUSINESS_STATUSES = new Set(['overdue', 'churned'])
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['trialing', 'active'])
type EntitlementErrorCode = 'FORBIDDEN' | 'QUOTA_EXCEEDED' | 'INSUFFICIENT_BALANCE'

function numberFromJson(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const candidate = Number(record.amount ?? record.limit ?? record.value)
    return Number.isFinite(candidate) ? candidate : 0
  }
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function stringArrayFromJson(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const candidates = record.allowed ?? record.values ?? record.items
    if (Array.isArray(candidates)) {
      return candidates.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    }
  }
  return null
}

function booleanFromJson(value: unknown, fallback: boolean) {
  if (typeof value === 'boolean') return value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (typeof record.enabled === 'boolean') return record.enabled
    if (typeof record.value === 'boolean') return record.value
  }
  return fallback
}

function resolveOveragePolicy(entitlements: Array<{ key: string; value: unknown }>) {
  const configured = entitlements.find((item) => item.key === 'overagePolicy')?.value
  const value = typeof configured === 'string'
    ? configured
    : configured && typeof configured === 'object' && !Array.isArray(configured)
      ? (configured as Record<string, unknown>).value
      : undefined
  if (value === 'balance' || value === 'block') return value

  // 迁移期兼容旧字段；缺失或非法值一律安全关闭。
  const legacy = entitlements.find((item) => item.key === 'allowOverage')?.value
  return booleanFromJson(legacy, false) ? 'balance' : 'block'
}

function entitlementError(code: EntitlementErrorCode, message: string, details?: Record<string, unknown>) {
  return Object.assign(new Error(message), {
    code,
    details: {
      ...(details || {}),
      source: 'organization_entitlements',
    },
  })
}

export async function resolveUserActiveOrganization(userId: string) {
  return prisma.organizationMember.findFirst({
    where: { userId, status: 'active', organization: { status: 'active' } },
    orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
    include: { organization: { include: { currentPlan: { include: { entitlements: true } } } } },
  })
}

async function resolveProjectOrganizationId(projectId?: string | null) {
  if (!projectId) return undefined
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { organizationId: true },
  })
  return project?.organizationId || null
}

async function resolveMembershipForOrganization(userId: string, organizationId: string) {
  return prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    include: { organization: { include: { currentPlan: { include: { entitlements: true } } } } },
  })
}

export async function assertOrganizationCanConsume(
  userId: string,
  estimatedCost: number,
  taskType?: string,
  options?: {
    organizationId?: string | null
    projectId?: string | null
  },
) {
  const projectOrganizationId = await resolveProjectOrganizationId(options?.projectId)
  const scopedOrganizationId =
    options?.organizationId !== undefined
      ? options.organizationId
      : projectOrganizationId

  if (scopedOrganizationId === null) return null

  const membership = scopedOrganizationId
    ? await resolveMembershipForOrganization(userId, scopedOrganizationId)
    : await resolveUserActiveOrganization(userId)
  if (!membership) {
    if (scopedOrganizationId) throw entitlementError('FORBIDDEN', '无企业成员权限', {
      organizationId: scopedOrganizationId,
    })
    return null
  }
  const organization = membership.organization
  if (organization.status !== 'active') throw entitlementError('FORBIDDEN', '企业已被禁用', {
    organizationId: organization.id,
  })
  if (membership.status !== 'active') throw entitlementError('FORBIDDEN', '成员已被禁用', {
    organizationId: organization.id,
    userId,
  })
  if (BLOCKED_BUSINESS_STATUSES.has(organization.businessStatus)) {
    throw entitlementError('FORBIDDEN', '企业订阅状态不可用', {
      organizationId: organization.id,
      businessStatus: organization.businessStatus,
    })
  }
  if (!organization.currentSubscriptionId) {
    throw entitlementError('FORBIDDEN', '企业订阅状态不可用', {
      organizationId: organization.id,
      businessStatus: organization.businessStatus,
    })
  }
  const subscription = await prisma.organizationSubscription.findUnique({
    where: { id: organization.currentSubscriptionId },
    select: { status: true, currentPeriodEnd: true },
  })
  if (!subscription || !ACTIVE_SUBSCRIPTION_STATUSES.has(subscription.status)) {
    throw entitlementError('FORBIDDEN', '企业订阅状态不可用', {
      organizationId: organization.id,
      subscriptionStatus: subscription?.status || null,
    })
  }
  if (!subscription.currentPeriodEnd) {
    throw entitlementError('FORBIDDEN', '企业订阅缺少有效账期', {
      organizationId: organization.id,
      subscriptionStatus: subscription.status,
    })
  }
  if (subscription.currentPeriodEnd.getTime() <= Date.now()) {
    await prisma.$transaction(async (tx) => {
      const expired = await tx.organizationSubscription.updateMany({
        where: { id: organization.currentSubscriptionId!, status: { in: ['trialing', 'active'] }, currentPeriodEnd: { lte: new Date() } },
        data: { status: 'expired' },
      })
      if (expired.count > 0) {
        await tx.organization.updateMany({
          where: { id: organization.id, currentSubscriptionId: organization.currentSubscriptionId },
          data: { currentSubscriptionId: null, currentPlanId: null, businessStatus: 'churned' },
        })
      }
    })
    throw entitlementError('FORBIDDEN', '企业订阅已过期', {
      organizationId: organization.id,
      subscriptionStatus: subscription.status,
      currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
    })
  }
  const plan = organization.currentPlan
  if (!plan || plan.status !== 'active') throw entitlementError('FORBIDDEN', '企业套餐不可用', {
    organizationId: organization.id,
    planStatus: plan?.status || null,
  })
  const taskTypes = stringArrayFromJson(plan?.entitlements.find((item) => item.key === 'taskTypes')?.value)
  if (Array.isArray(taskTypes) && taskType && !taskTypes.includes(taskType)) {
    throw entitlementError('FORBIDDEN', '当前套餐不支持该任务类型', {
      organizationId: organization.id,
      taskType,
    })
  }
  // Legacy live gate. 0 and null are unlimited here. null = unlimited / 0 = forbidden
  // lives in checkMemberQuota and planTieredDeduction and is not wired into this path.
  const memberQuota = Number(membership.quota || 0)
  const monthStart = new Date()
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)
  const reservedByMember = memberQuota > 0
    ? await prisma.organizationUsage.aggregate({
      where: {
        organizationId: organization.id,
        userId,
        createdAt: { gte: monthStart },
        OR: [
          { type: 'task' },
          { type: 'freeze', metadata: { path: '$.status', equals: 'pending' } },
        ],
      },
      _sum: { planCreditAmount: true, balanceAmount: true },
    })
    : null
  const memberUsed = reservedByMember
    ? Number(reservedByMember._sum.planCreditAmount || 0) + Number(reservedByMember._sum.balanceAmount || 0)
    : 0
  if (memberQuota > 0 && memberUsed + estimatedCost > memberQuota) {
    throw entitlementError('QUOTA_EXCEEDED', '成员配额不足', {
      organizationId: organization.id,
      required: estimatedCost,
      available: Math.max(0, memberQuota - memberUsed),
    })
  }
  const planCredit = numberFromJson(plan?.entitlements.find((item) => item.key === 'monthlyCredits')?.value)
  const used = await prisma.organizationUsage.aggregate({
    where: {
      organizationId: organization.id,
      createdAt: { gte: monthStart },
      OR: [
        { type: 'task' },
        { type: 'freeze', metadata: { path: '$.status', equals: 'pending' } },
      ],
    },
    _sum: { planCreditAmount: true },
  })
  const planCreditUsed = Number(used._sum.planCreditAmount || 0)
  const planRemaining = Math.max(0, planCredit - planCreditUsed)
  const balanceNeed = Math.max(0, estimatedCost - planRemaining)
  const balance = await prisma.organizationBalance.findUnique({ where: { organizationId: organization.id } })
  const available = balance ? Number(balance.balance) : 0
  const overagePolicy = resolveOveragePolicy(plan.entitlements)
  if (balanceNeed > 0 && overagePolicy !== 'balance') throw entitlementError('QUOTA_EXCEEDED', '套餐权益不足且不允许超额', {
    organizationId: organization.id,
    required: estimatedCost,
    available: planRemaining,
  })
  if (balanceNeed > 0 && available < balanceNeed) throw entitlementError('INSUFFICIENT_BALANCE', '企业余额不足', {
    organizationId: organization.id,
    required: balanceNeed,
    available,
  })
  const result = {
    organizationId: organization.id,
    planCreditApplied: Math.min(estimatedCost, planRemaining),
    balanceChargeApplied: balanceNeed,
  }
  return Object.defineProperties(result, {
    memberQuota: { value: memberQuota, enumerable: false },
    monthlyPlanCredit: { value: planCredit, enumerable: false },
  }) as typeof result & { memberQuota: number; monthlyPlanCredit: number }
}
