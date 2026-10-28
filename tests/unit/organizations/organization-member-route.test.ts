import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMockRequest } from '../../helpers/request'

const permissionMock = vi.hoisted(() => ({
  requireOrganizationRole: vi.fn(),
  writeEnterpriseAudit: vi.fn(),
}))

const prismaMock = vi.hoisted(() => ({
  user: { findFirst: vi.fn() },
  organization: { findUnique: vi.fn() },
  organizationMember: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
}))

vi.mock('@/lib/api-auth', () => ({
  requireUserAuth: vi.fn(async () => ({ session: { user: { id: 'admin-1' } } })),
  isErrorResponse: (value: unknown) => value instanceof Response,
  forbidden: (message: string) => Response.json({ error: message }, { status: 403 }),
  notFound: (resource: string) => Response.json({ error: `${resource} not found` }, { status: 404 }),
  badRequest: (message: string) => Response.json({ error: message }, { status: 400 }),
}))
vi.mock('@/lib/saas/permissions', () => permissionMock)
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/prisma-retry', () => ({ withPrismaRetry: async <T>(operation: () => Promise<T>) => operation() }))
vi.mock('@/lib/api-errors', () => ({
  apiHandler: <TParams extends Record<string, string>>(handler: (req: Request, ctx: { params: Promise<TParams> }) => Promise<Response>) =>
    async (req: Request, ctx: { params: Promise<TParams> }) => handler(req, ctx),
}))

const routeContext = { params: Promise.resolve({ id: 'org-1', userId: 'member-1' }) }
const activeAdmin = { id: 'membership-1', organizationId: 'org-1', userId: 'admin-1', role: 'admin', status: 'active' }

describe('organization member management routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    permissionMock.requireOrganizationRole.mockResolvedValue({ error: null, membership: activeAdmin })
    permissionMock.writeEnterpriseAudit.mockResolvedValue(undefined)
  })

  it('rejects a frozen or disabled actor before any member-management write', async () => {
    const denied = Response.json({ error: 'member is frozen' }, { status: 403 })
    permissionMock.requireOrganizationRole.mockResolvedValueOnce({ error: denied, membership: null })
    const createRoute = await import('@/app/api/organizations/[id]/members/route')

    const createResponse = await createRoute.POST(
      buildMockRequest({ path: '/api/organizations/org-1/members', method: 'POST', body: { email: 'person@example.com', role: 'member' } }),
      routeContext,
    )

    expect(createResponse.status).toBe(403)
    expect(prismaMock.user.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.organizationMember.create).not.toHaveBeenCalled()
  })

  it.each([
    ['PATCH', 'PATCH'],
    ['DELETE', 'DELETE'],
  ] as const)('rejects a disabled actor before resolving a target member for %s', async (_name, method) => {
    const denied = Response.json({ error: 'organization is disabled' }, { status: 403 })
    permissionMock.requireOrganizationRole.mockResolvedValueOnce({ error: denied, membership: null })
    const route = await import('@/app/api/organizations/[id]/members/[userId]/route')
    const request = buildMockRequest({
      path: '/api/organizations/org-1/members/member-1',
      method,
      ...(method === 'PATCH' ? { body: { status: 'frozen' } } : {}),
    })

    const response = method === 'PATCH'
      ? await route.PATCH(request, routeContext)
      : await route.DELETE(request, routeContext)

    expect(response.status).toBe(403)
    expect(prismaMock.organizationMember.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.organizationMember.update).not.toHaveBeenCalled()
    expect(prismaMock.organizationMember.delete).not.toHaveBeenCalled()
  })

  it('allows an active organization admin to invite a normal member', async () => {
    prismaMock.user.findFirst.mockResolvedValue({ id: 'member-2', email: 'person@example.com' })
    prismaMock.organization.findUnique
      .mockResolvedValueOnce({ members: [] })
      .mockResolvedValueOnce({ currentPlan: null, _count: { members: 1 } })
    prismaMock.organizationMember.create.mockResolvedValue({
      id: 'membership-2', organizationId: 'org-1', userId: 'member-2', role: 'member', status: 'active',
      user: { id: 'member-2', name: 'Person', email: 'person@example.com', image: null },
    })
    const route = await import('@/app/api/organizations/[id]/members/route')

    const response = await route.POST(
      buildMockRequest({ path: '/api/organizations/org-1/members', method: 'POST', body: { email: 'person@example.com', role: 'member' } }),
      routeContext,
    )

    expect(response.status).toBe(201)
    expect(permissionMock.requireOrganizationRole).toHaveBeenCalledWith('org-1', 'admin-1', ['owner', 'admin'])
    expect(prismaMock.organizationMember.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ organizationId: 'org-1', userId: 'member-2', role: 'member', quota: null }),
    }))
  })

  it('adds a self-registered account without requiring an email address', async () => {
    prismaMock.user.findFirst.mockResolvedValue({ id: 'member-2', name: '13800138000', email: null })
    prismaMock.organization.findUnique
      .mockResolvedValueOnce({ members: [] })
      .mockResolvedValueOnce({ currentPlan: null, _count: { members: 1 } })
    prismaMock.organizationMember.create.mockResolvedValue({ id: 'membership-2' })
    const { POST } = await import('@/app/api/organizations/[id]/members/route')
    const response = await POST(buildMockRequest({ path: '/api/organizations/org-1/members', method: 'POST',
      body: { account: '13800138000', role: 'member' },
    }), routeContext)
    expect(response.status).toBe(201)
    expect(prismaMock.user.findFirst).toHaveBeenCalledWith({ where: { name: '13800138000' } })
    expect(prismaMock.organizationMember.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'member-2', quota: null }),
    }))
  })

  it('allows an active organization admin to promote an ordinary member to administrator', async () => {
    prismaMock.organizationMember.findUnique.mockResolvedValue({
      id: 'membership-2', organizationId: 'org-1', userId: 'member-2', role: 'member', status: 'active',
    })
    prismaMock.organizationMember.update.mockResolvedValue({
      id: 'membership-2', organizationId: 'org-1', userId: 'member-2', role: 'admin', status: 'active',
      user: { id: 'member-2', name: 'Person', email: 'person@example.com', image: null },
    })
    const route = await import('@/app/api/organizations/[id]/members/[userId]/route')

    const response = await route.PATCH(
      buildMockRequest({ path: '/api/organizations/org-1/members/member-2', method: 'PATCH', body: { role: 'admin' } }),
      { params: Promise.resolve({ id: 'org-1', userId: 'member-2' }) },
    )

    expect(response.status).toBe(200)
    expect(prismaMock.organizationMember.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ role: 'admin' }),
    }))
  })

  it('keeps the active-member read path while rejecting an inactive member before listing the directory', async () => {
    const route = await import('@/app/api/organizations/[id]/members/route')
    const denied = Response.json({ error: 'member is frozen' }, { status: 403 })
    permissionMock.requireOrganizationRole.mockResolvedValueOnce({ error: denied, membership: null })

    const deniedResponse = await route.GET(buildMockRequest({ path: '/api/organizations/org-1/members', method: 'GET' }), routeContext)

    expect(deniedResponse.status).toBe(403)
    expect(prismaMock.organizationMember.findMany).not.toHaveBeenCalled()

    permissionMock.requireOrganizationRole.mockResolvedValueOnce({ error: null, membership: { ...activeAdmin, role: 'member' } })
    prismaMock.organizationMember.findMany.mockResolvedValueOnce([])
    const allowedResponse = await route.GET(buildMockRequest({ path: '/api/organizations/org-1/members', method: 'GET' }), routeContext)

    expect(allowedResponse.status).toBe(200)
    expect(permissionMock.requireOrganizationRole).toHaveBeenLastCalledWith('org-1', 'admin-1', ['owner', 'admin', 'member'])
  })
})
