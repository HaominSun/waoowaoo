import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { withPrismaRetry } from '@/lib/prisma-retry'
import { requireUserAuth, isErrorResponse, badRequest } from '@/lib/api-auth'
import { apiHandler } from '@/lib/api-errors'

/**
 * POST /api/organizations
 * 创建组织
 * 请求体: { name: string, slug: string }
 * 返回: 创建的组织（创建者为 owner）
 */
export const POST = apiHandler(async (req) => {
  const authResult = await requireUserAuth()
  if (isErrorResponse(authResult)) return authResult
  const { session } = authResult

  const body = await req.json()
  const { name, slug } = body

  if (!name || typeof name !== 'string' || !name.trim()) {
    return badRequest('组织名称不能为空')
  }
  if (!slug || typeof slug !== 'string' || !slug.trim()) {
    return badRequest('组织slug不能为空')
  }

  // 验证 slug 格式
  const slugRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/
  if (!slugRegex.test(slug)) {
    return badRequest('slug 只能包含小写字母、数字和连字符，且不能以连字符开头或结尾')
  }

  // 检查 slug 是否已存在
  const existingOrg = await withPrismaRetry(() =>
    prisma.organization.findUnique({ where: { slug } })
  )
  if (existingOrg) {
    return badRequest('该 slug 已被使用')
  }

  // 创建组织和成员关系（事务）
  const organization = await withPrismaRetry(() =>
    prisma.$transaction(async (tx) => {
      // 创建组织
      const org = await tx.organization.create({
        data: {
          name: name.trim(),
          slug: slug.trim(),
          ownerId: session.user.id,
        },
      })

      // 创建组织余额
      await tx.organizationBalance.create({
        data: {
          organizationId: org.id,
        },
      })

      // 创建 owner 成员
      await tx.organizationMember.create({
        data: {
          organizationId: org.id,
          userId: session.user.id,
          role: 'owner',
          quota: null,
          status: 'active',
        },
      })

      return org
    })
  )

  // 获取完整组织信息（含成员）
  const fullOrganization = await withPrismaRetry(() =>
    prisma.organization.findUnique({
      where: { id: organization.id },
      include: {
        members: {
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
        },
        balance: true,
      },
    })
  )

  return NextResponse.json(fullOrganization, { status: 201 })
})

/**
 * GET /api/organizations
 * 获取当前用户所属的组织列表
 */
export const GET = apiHandler(async () => {
  const authResult = await requireUserAuth()
  if (isErrorResponse(authResult)) return authResult
  const { session } = authResult

  const organizations = await withPrismaRetry(() =>
    prisma.organization.findMany({
      where: {
        status: 'active',
        members: {
          some: {
            userId: session.user.id,
            status: 'active',
          },
        },
      },
      include: {
        owner: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
        members: {
          where: {
            userId: session.user.id,
            status: 'active',
          },
          select: {
            role: true,
            status: true,
          },
        },
        balance: true,
        _count: {
          select: { members: true },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    })
  )

  // 格式化返回数据
  const result = organizations.map((org) => ({
    id: org.id,
    name: org.name,
    slug: org.slug,
    createdAt: org.createdAt,
    updatedAt: org.updatedAt,
    owner: org.owner,
    currentUserRole: org.members[0]?.role || 'member',
    currentUserStatus: org.members[0]?.status || 'active',
    balance: org.balance,
    memberCount: org._count.members,
  }))

  return NextResponse.json(result)
})
