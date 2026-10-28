import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { withPrismaRetry } from '@/lib/prisma-retry'
import { createAdminAuditLog, requirePlatformAdmin } from '@/lib/platform-admin'
import { apiHandler } from '@/lib/api-errors'
import { badRequest } from '@/lib/api-auth'

/**
 * GET /api/platform/organizations/[id]/members
 * 平台管理员查看任意组织成员列表
 */
export const GET = apiHandler(async (_req, ctx) => {
  const params = await ctx.params
  const organizationId = params.id as string

  const authResult = await requirePlatformAdmin()
  if (authResult instanceof NextResponse) return authResult

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
        { role: 'asc' },
        { joinedAt: 'asc' },
      ],
    })
  )

  return NextResponse.json(members)
})

/**
 * POST /api/platform/organizations/[id]/members
 * 设置组织管理员。目标账号可为已有成员或平台中的其他有效账号。
 */
export const POST = apiHandler<{ id: string }>(async (req, ctx) => {
  const authResult = await requirePlatformAdmin()
  if (authResult instanceof NextResponse) return authResult
  const { user: platformAdmin } = authResult
  const { id: organizationId } = await ctx.params

  let body: { userId?: unknown }
  try {
    body = await req.json()
  } catch {
    return badRequest('Request body must be valid JSON')
  }

  const userId = typeof body.userId === 'string' ? body.userId.trim() : ''
  if (!userId) return badRequest('An administrator account must be selected')

  const [organization, targetUser] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, ownerId: true, status: true },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, isGlobalLocked: true },
    }),
  ])

  if (!organization) return NextResponse.json({ error: 'Organization not found' }, { status: 404 })
  if (organization.status !== 'active') return badRequest('Organization must be active before assigning an administrator')
  if (!targetUser) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  if (targetUser.isGlobalLocked) return badRequest('A locked account cannot be an organization administrator')
  if (organization.ownerId === userId) return badRequest('The organization owner already has administrator authority')

  let result: { membership: { id: string }; previousRole: string | null }
  try {
    result = await prisma.$transaction(async (tx) => {
      const existingMember = await tx.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId, userId } },
      })

      if (existingMember) {
        const membership = await tx.organizationMember.update({
          where: { organizationId_userId: { organizationId, userId } },
          data: { role: 'admin', status: 'active' },
        })
        return { membership, previousRole: existingMember.role }
      }

      const organizationWithPlan = await tx.organization.findUnique({
        where: { id: organizationId },
        include: {
          currentPlan: { include: { entitlements: true } },
          _count: { select: { members: true } },
        },
      })
      const memberLimit = organizationWithPlan?.currentPlan?.entitlements.find((item) => item.key === 'memberLimit')
      const rawLimit = memberLimit?.value
      const limit = typeof rawLimit === 'number' ? rawLimit : null
      if (limit && limit > 0 && (organizationWithPlan?._count.members || 0) >= limit) {
        throw new Error('Organization member limit has been reached')
      }

      const membership = await tx.organizationMember.create({
        data: { organizationId, userId, role: 'admin', status: 'active', quota: null },
      })
      return { membership, previousRole: null }
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'Organization member limit has been reached') {
      return badRequest(error.message)
    }
    throw error
  }

  await createAdminAuditLog({
    adminId: platformAdmin.id,
    action: 'set_organization_admin',
    targetType: 'OrganizationMember',
    targetId: result.membership.id,
    details: { organizationId, userId, previousRole: result.previousRole, role: 'admin' },
  })

  return NextResponse.json({ data: result.membership })
})
