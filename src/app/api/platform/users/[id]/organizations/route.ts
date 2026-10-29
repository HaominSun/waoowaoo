import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requirePlatformAdmin, createAdminAuditLog } from '@/lib/platform-admin'
import { apiHandler } from '@/lib/api-errors'

/**
 * POST /api/platform/users/[id]/organizations
 * 将用户关联到组织
 * 请求体：{ organizationId: string, role?: string }
 */
export const POST = apiHandler<{ id: string }>(async (req, { params }) => {
  const authResult = await requirePlatformAdmin()
  if (authResult instanceof NextResponse) return authResult
  const { user: admin } = authResult

  const { id: userId } = await params
  const body = await req.json()
  const { organizationId, role = 'member' } = body

  if (!organizationId) {
    return NextResponse.json({ error: 'organizationId is required' }, { status: 400 })
  }

  // 验证用户存在
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true },
  })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  // 验证组织存在
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, name: true },
  })
  if (!org) {
    return NextResponse.json({ error: 'Organization not found' }, { status: 404 })
  }

  // 检查是否已经是成员
  const existing = await prisma.organizationMember.findUnique({
    where: {
      organizationId_userId: {
        organizationId,
        userId,
      },
    },
  })
  if (existing) {
    return NextResponse.json({ error: 'User is already a member of this organization' }, { status: 409 })
  }

  // 创建成员关系
  const member = await prisma.organizationMember.create({
    data: {
      organizationId,
      userId,
      role,
      quota: null,
      status: 'active',
    },
    include: {
      organization: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
    },
  })

  // 记录审计日志
  await createAdminAuditLog({
    adminId: admin.id,
    action: 'add_user_to_organization',
    targetType: 'User',
    targetId: userId,
    details: {
      organizationId,
      organizationName: org.name,
      userName: user.name,
      role,
    },
  })

  return NextResponse.json({ data: member }, { status: 201 })
})

/**
 * DELETE /api/platform/users/[id]/organizations
 * 将用户从组织移除
 * 请求体：{ organizationId: string }
 */
export const DELETE = apiHandler<{ id: string }>(async (req, { params }) => {
  const authResult = await requirePlatformAdmin()
  if (authResult instanceof NextResponse) return authResult
  const { user: admin } = authResult

  const { id: userId } = await params
  const body = await req.json()
  const { organizationId } = body

  if (!organizationId) {
    return NextResponse.json({ error: 'organizationId is required' }, { status: 400 })
  }

  const existing = await prisma.organizationMember.findUnique({
    where: {
      organizationId_userId: {
        organizationId,
        userId,
      },
    },
    include: {
      organization: { select: { name: true } },
      user: { select: { name: true } },
    },
  })

  if (!existing) {
    return NextResponse.json({ error: 'User is not a member of this organization' }, { status: 404 })
  }

  // 不允许移除 owner
  if (existing.role === 'owner') {
    return NextResponse.json({ error: 'Cannot remove the organization owner' }, { status: 400 })
  }

  await prisma.organizationMember.delete({
    where: {
      organizationId_userId: {
        organizationId,
        userId,
      },
    },
  })

  await createAdminAuditLog({
    adminId: admin.id,
    action: 'remove_user_from_organization',
    targetType: 'User',
    targetId: userId,
    details: {
      organizationId,
      organizationName: existing.organization.name,
      userName: existing.user.name,
    },
  })

  return NextResponse.json({ message: 'User removed from organization' })
})
