import { beforeEach, describe, expect, it, vi } from 'vitest'

const prismaMock = vi.hoisted(() => ({
  project: { findUnique: vi.fn() },
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

import { resolveChargeAttribution } from '@/lib/billing/charge-attribution'

describe('resolveChargeAttribution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('charges the project organization when the project has one', async () => {
    const loadProject = vi.fn().mockResolvedValue({ organizationId: 'org-1' })
    await expect(resolveChargeAttribution('project-1', loadProject)).resolves.toEqual({
      target: 'organization',
      organizationId: 'org-1',
    })
    expect(loadProject).toHaveBeenCalledWith('project-1')
  })

  it('uses the personal balance when the project has no organization', async () => {
    const loadProject = vi.fn()
      .mockResolvedValueOnce({ organizationId: null })
      .mockResolvedValueOnce(null)
    await expect(resolveChargeAttribution('project-2', loadProject)).resolves.toEqual({ target: 'personal' })
    await expect(resolveChargeAttribution('missing', loadProject)).resolves.toEqual({ target: 'personal' })
  })

  it('does not look up virtual or blank project ids', async () => {
    const loadProject = vi.fn()
    await expect(resolveChargeAttribution('asset-hub', loadProject)).resolves.toEqual({ target: 'personal' })
    await expect(resolveChargeAttribution('global-asset-hub', loadProject)).resolves.toEqual({ target: 'personal' })
    await expect(resolveChargeAttribution('system', loadProject)).resolves.toEqual({ target: 'personal' })
    await expect(resolveChargeAttribution('  ', loadProject)).resolves.toEqual({ target: 'personal' })
    await expect(resolveChargeAttribution(null, loadProject)).resolves.toEqual({ target: 'personal' })
    expect(loadProject).not.toHaveBeenCalled()
  })

  it('loads the project organization through prisma by default', async () => {
    prismaMock.project.findUnique.mockResolvedValue({ organizationId: 'org-db' })
    await expect(resolveChargeAttribution('project-db')).resolves.toEqual({
      target: 'organization',
      organizationId: 'org-db',
    })
    expect(prismaMock.project.findUnique).toHaveBeenCalledWith({
      where: { id: 'project-db' },
      select: { organizationId: true },
    })
  })
})
