import { prisma } from '@/lib/prisma'

/** Same virtual project ids as usage-cost recording. They have no organization balance. */
const PERSONAL_PROJECT_IDS = new Set(['asset-hub', 'global-asset-hub', 'system'])

export type ChargeAttribution =
  | { target: 'organization'; organizationId: string }
  | { target: 'personal' }

export type ProjectOrganizationLoader = (
  projectId: string,
) => Promise<{ organizationId: string | null } | null>

export async function loadProjectOrganization(projectId: string): Promise<{ organizationId: string | null } | null> {
  return prisma.project.findUnique({
    where: { id: projectId },
    select: { organizationId: true },
  })
}

/**
 * Attribute a charge to the project's organization when the project has one.
 * Otherwise use the personal balance. The user's current organization is not consulted.
 * prepareTaskBilling still uses assertOrganizationCanConsume; call this when that path is replaced.
 */
export async function resolveChargeAttribution(
  projectId: string | null | undefined,
  loadProject: ProjectOrganizationLoader = loadProjectOrganization,
): Promise<ChargeAttribution> {
  const id = typeof projectId === 'string' ? projectId.trim() : ''
  if (!id || PERSONAL_PROJECT_IDS.has(id)) return { target: 'personal' }
  const project = await loadProject(id)
  if (project?.organizationId) {
    return { target: 'organization', organizationId: project.organizationId }
  }
  return { target: 'personal' }
}
