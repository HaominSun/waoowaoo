import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { withPrismaRetry } from '@/lib/prisma-retry'
import { requireUserAuth, isErrorResponse, forbidden, notFound, badRequest } from '@/lib/api-auth'
import { apiHandler } from '@/lib/api-errors'
import { requireOrganizationRole, writeEnterpriseAudit } from '@/lib/saas/permissions'

/**
 * POST /api/organizations/[id]/members
 * 邀请成员
 * 请求体: { email: string, role?: "admin" | "member" }
 * 权限: owner 或 admin
 */
export const POST = apiHandler(async (req, ctx) => {
  const params = await ctx.params
  const organizationId = params.id as string

  const authResult = await requireUserAuth()
  if (isErrorResponse(authResult)) return authResult
  const { session } = authResult

  // 验证权限
  const permResult = await requireOrganizationRole(organizationId, session.user.id, ['owner', 'admin'])
  if (permResult.error) return permResult.error

  const { membership: currentUser } = permResult

  const body = await req.json()
  const { role = 'member' } = body
  const email = body.account ?? body.email

  if (!email || typeof email !== 'string' || !email.trim()) {
    return badRequest('账号或邮箱不能为空')
  }

  // 验证 role
  if (role !== 'admin' && role !== 'member') {
    return badRequest('角色只能是 admin 或 member')
  }

  // 检查当前用户是否有权限分配该角色
  // admin 只能分配 member 角色
  if (currentUser?.role === 'admin' && role === 'admin') {
    return forbidden('管理员只能邀请普通成员')
  }

  // 查找被邀请的用户 (使用 findFirst 因为 email 不是唯一索引)
  const invitee = await withPrismaRetry(() =>
    prisma.user.findFirst({
      where: email.includes('@') ? { email: email.trim().toLowerCase() } : { name: email.trim() },
    })
  )

  if (!invitee) {
    // 如果用户不存在，返回友好提示（实际生产中可能需要发送邀请邮件）
    return badRequest('找不到该账号或邮箱对应的用户，请先完成注册')
  }
  if (invitee.isGlobalLocked) return forbidden('该账号已被禁用')

  // 获取组织信息
  const organization = await withPrismaRetry(() =>
    prisma.organization.findUnique({
      where: { id: organizationId },
      include: {
        members: true,
      },
    })
  )

  if (!organization) {
    return notFound('Organization')
  }

  // 检查是否已经是成员
  const existingMember = (organization as { members: Array<{ userId: string }> }).members.find((m) => m.userId === invitee.id)
  if (existingMember) {
    return badRequest('该用户已经是组织成员')
  }

  const memberLimit = await withPrismaRetry(async () => {
    const org = await prisma.organization.findUnique({ where: { id: organizationId }, include: { currentPlan: { include: { entitlements: true } }, _count: { select: { members: true } } } })
    const entitlement = org?.currentPlan?.entitlements.find((item) => item.key === 'memberLimit')
    const raw = entitlement?.value
    return typeof raw === 'number' ? { limit: raw, count: org?._count.members || 0 } : null
  })
  if (memberLimit && memberLimit.limit > 0 && memberLimit.count >= memberLimit.limit) {
    return forbidden('企业成员数已达到套餐上限')
  }

  // 创建成员关系
  const member = await withPrismaRetry(() =>
    prisma.organizationMember.create({
      data: {
        organizationId,
        userId: invitee.id,
        role,
        quota: null,
        status: 'active',
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
      },
    })
  )
  await writeEnterpriseAudit({ organizationId, actorId: session.user.id, action: 'add_member', targetType: 'OrganizationMember', targetId: member.id, details: { userId: invitee.id, role } })

  return NextResponse.json(member, { status: 201 })
})

/**
 * GET /api/organizations/[id]/members
 * 获取成员列表
 */
export const GET = apiHandler(async (_req, ctx) => {
  const params = await ctx.params
  const organizationId = params.id as string

  const authResult = await requireUserAuth()
  if (isErrorResponse(authResult)) return authResult
  const { session } = authResult

  const permResult = await requireOrganizationRole(organizationId, session.user.id, ['owner', 'admin', 'member'])
  if (permResult.error) return permResult.error

  // 获取成员列表
  const members = await withPrismaRetry(() =>
    prisma.organizationMember.findMany({
      where: { organizationId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
      },
      orderBy: [
        { role: 'asc' }, // owner 最前
        { joinedAt: 'asc' },
      ],
    })
  )

  return NextResponse.json(members)
})
