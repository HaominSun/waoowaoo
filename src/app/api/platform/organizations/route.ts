import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requirePlatformAdmin, createAdminAuditLog } from '@/lib/platform-admin'
import { apiHandler } from '@/lib/api-errors'
import { badRequest } from '@/lib/api-auth'
import { ORGANIZATION_STATUSES, readPlatformPagination, readStringEnum } from '@/lib/platform/validation'

/**
 * GET /api/platform/organizations
 * 获取所有组织（分页）
 * 查询参数：page, limit, search, status
 * 返回：组织列表（包含余额、成员数量）
 */
export const GET = apiHandler(async (req) => {
  const authResult = await requirePlatformAdmin()
  if (authResult instanceof NextResponse) return authResult

  const { searchParams } = new URL(req.url)

  let page: number
  let limit: number
  let skip: number
  try {
    ({ page, limit, skip } = readPlatformPagination(searchParams, { limit: 10 }))
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : 'Invalid pagination parameters')
  }
  const search = searchParams.get('search') || ''
  const status = searchParams.get('status') || ''

  const where: Record<string, unknown> = {}

  if (search) {
    where.OR = [
      { name: { contains: search } },
      { slug: { contains: search } },
    ]
  }

  if (status) {
    try {
      where.status = readStringEnum(status, 'status', ORGANIZATION_STATUSES)
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : 'Invalid organization status')
    }
  }

  const [organizations, total] = await Promise.all([
    prisma.organization.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        owner: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        balance: true,
        currentPlan: true,
        subscriptions: {
          take: 1,
          orderBy: { createdAt: 'desc' },
          include: { plan: true },
        },
        _count: {
          select: {
            members: true,
          },
        },
      },
    }),
    prisma.organization.count({ where }),
  ])

  const result = organizations.map((org) => ({
    id: org.id,
    name: org.name,
    slug: org.slug,
    status: org.status,
    businessStatus: org.businessStatus,
    createdAt: org.createdAt,
    updatedAt: org.updatedAt,
    owner: org.owner,
    balance: org.balance ? {
      balance: Number(org.balance.balance),
      frozenAmount: Number(org.balance.frozenAmount),
      totalSpent: Number(org.balance.totalSpent),
    } : null,
    currentPlan: org.currentPlan,
    currentSubscription: org.subscriptions[0] || null,
    memberCount: org._count.members,
  }))

  return NextResponse.json({
    data: result,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  })
})

/**
 * POST /api/platform/organizations
 * 创建组织
 */
export const POST = apiHandler(async (req) => {
  const authResult = await requirePlatformAdmin()
  if (authResult instanceof NextResponse) return authResult
  const { user } = authResult

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return badRequest('Request body must be valid JSON')
  }
  const { name, slug, ownerId, status = 'active', settings } = body

  if (typeof name !== 'string' || !name.trim() || typeof slug !== 'string' || !slug.trim()) {
    return NextResponse.json({ error: 'name and slug are required' }, { status: 400 })
  }

  const normalizedName = name.trim()
  const normalizedSlug = slug.trim()
  if (normalizedName.length > 120 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalizedSlug) || normalizedSlug.length > 80) {
    return badRequest('Invalid organization name or slug')
  }
  let normalizedStatus: (typeof ORGANIZATION_STATUSES)[number]
  try {
    normalizedStatus = readStringEnum(status, 'status', ORGANIZATION_STATUSES)
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : 'Invalid organization status')
  }
  if (typeof ownerId !== 'string' || !ownerId.trim()) {
    return badRequest('An organization owner must be selected')
  }
  if (settings !== undefined && (typeof settings !== 'object' || settings === null || Array.isArray(settings))) {
    return badRequest('settings must be an object')
  }
  const effectiveOwnerId = ownerId.trim()
  const owner = await prisma.user.findUnique({ where: { id: effectiveOwnerId }, select: { id: true, isGlobalLocked: true } })
  if (!owner) return NextResponse.json({ error: 'Owner not found' }, { status: 404 })
  if (owner.isGlobalLocked) return badRequest('A locked account cannot be the organization owner')

  const existing = await prisma.organization.findUnique({ where: { slug: normalizedSlug } })
  if (existing) {
    return NextResponse.json({ error: 'slug already exists' }, { status: 409 })
  }

  const organization = await prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: {
        name: normalizedName,
        slug: normalizedSlug,
        ownerId: effectiveOwnerId,
        status: normalizedStatus,
        settings: settings && typeof settings === 'object' ? settings : undefined,
      },
    })

    await tx.organizationBalance.create({
      data: {
        organizationId: org.id,
        balance: 0,
        frozenAmount: 0,
        totalSpent: 0,
      },
    })

    await tx.organizationMember.create({
      data: {
        organizationId: org.id,
        userId: effectiveOwnerId,
        role: 'owner',
        status: 'active',
        quota: null,
      },
    })

    return org
  })

  await createAdminAuditLog({
    adminId: user.id,
    action: 'create_organization',
    targetType: 'Organization',
    targetId: organization.id,
    details: { name: normalizedName, slug: normalizedSlug, ownerId: effectiveOwnerId, createdByPlatformAdmin: user.id },
  })

  return NextResponse.json({ data: organization }, { status: 201 })
})
