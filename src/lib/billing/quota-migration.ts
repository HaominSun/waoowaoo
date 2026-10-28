/**
 * Legacy OrganizationMember.quota used 0 as unlimited (schema comment and the live
 * entitlement gate). The new rule is null = unlimited and 0 = forbidden.
 * Converting stored 0 to null keeps today's effective unlimited behavior.
 *
 * Risk: a row whose 0 was meant to disable the member becomes unlimited.
 * The backup table is the review list. Rollback restores only rows still null.
 * Re-applying the forward migration after rollback converts every current 0 again,
 * including intentional disables created in between.
 *
 * The SQL statements below are what `prisma migrate` runs. applyMemberQuotaZeroToNull
 * is the same rule for tests and for reviewers. Keep them in lockstep.
 */

export const MEMBER_QUOTA_ZERO_TO_NULL_MARKER = 'organization_member_quota_0_to_null'

export const MEMBER_QUOTA_BACKUP_INSERT = `INSERT INTO \`organization_member_quota_zero_backup\` (\`id\`, \`memberId\`, \`organizationId\`, \`userId\`, \`oldQuota\`, \`backedUpAt\`)
SELECT m.\`id\`, m.\`id\`, m.\`organizationId\`, m.\`userId\`, m.\`quota\`, CURRENT_TIMESTAMP(3)
FROM \`organization_members\` AS m
WHERE m.\`quota\` = 0
  AND NOT EXISTS (
    SELECT 1
    FROM \`billing_data_migration_markers\` AS marker
    WHERE marker.\`name\` = '${MEMBER_QUOTA_ZERO_TO_NULL_MARKER}'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM \`organization_member_quota_zero_backup\` AS backup
    WHERE backup.\`memberId\` = m.\`id\`
  )`

export const MEMBER_QUOTA_ZERO_TO_NULL_UPDATE = `UPDATE \`organization_members\` AS m
SET m.\`quota\` = NULL
WHERE m.\`quota\` = 0
  AND NOT EXISTS (
    SELECT 1
    FROM \`billing_data_migration_markers\` AS marker
    WHERE marker.\`name\` = '${MEMBER_QUOTA_ZERO_TO_NULL_MARKER}'
  )`

export const MEMBER_QUOTA_MARKER_INSERT = `INSERT INTO \`billing_data_migration_markers\` (\`name\`, \`appliedAt\`, \`details\`)
SELECT '${MEMBER_QUOTA_ZERO_TO_NULL_MARKER}', CURRENT_TIMESTAMP(3), JSON_OBJECT('reason', 'legacy OrganizationMember.quota 0 meant unlimited; null preserves that behavior')
WHERE NOT EXISTS (
  SELECT 1
  FROM \`billing_data_migration_markers\` AS marker
  WHERE marker.\`name\` = '${MEMBER_QUOTA_ZERO_TO_NULL_MARKER}'
)`

export const CREDITS_PER_CNY_SEED = `INSERT INTO \`system_configs\` (\`id\`, \`key\`, \`value\`, \`description\`, \`updatedAt\`)
SELECT 'cfg_credits_per_cny', 'credits_per_cny', '1', 'Placeholder display rate. Ledger amounts stay in CNY. 1 credit equals 1 CNY until product sets the rate.', CURRENT_TIMESTAMP(3)
WHERE NOT EXISTS (
  SELECT 1
  FROM \`system_configs\` AS config
  WHERE config.\`key\` = 'credits_per_cny'
)`

export const MEMBER_QUOTA_ZERO_TO_NULL_STATEMENTS = [
  MEMBER_QUOTA_BACKUP_INSERT,
  MEMBER_QUOTA_ZERO_TO_NULL_UPDATE,
  MEMBER_QUOTA_MARKER_INSERT,
] as const

export const MEMBER_QUOTA_ROLLBACK_RESTORE = `UPDATE \`organization_members\` AS m
INNER JOIN \`organization_member_quota_zero_backup\` AS b ON b.\`memberId\` = m.\`id\`
SET m.\`quota\` = b.\`oldQuota\`
WHERE m.\`quota\` IS NULL`

export const MEMBER_QUOTA_ROLLBACK_CLEAR_MARKER = `DELETE FROM \`billing_data_migration_markers\`
WHERE \`name\` = '${MEMBER_QUOTA_ZERO_TO_NULL_MARKER}'`

export const MEMBER_QUOTA_ROLLBACK_STATEMENTS = [
  MEMBER_QUOTA_ROLLBACK_RESTORE,
  MEMBER_QUOTA_ROLLBACK_CLEAR_MARKER,
] as const

export type QuotaMemberRow = {
  id: string
  organizationId: string
  userId: string
  quota: number | null
}

export type QuotaBackupRow = {
  id: string
  memberId: string
  organizationId: string
  userId: string
  oldQuota: number
}

export type QuotaMigrationState = {
  members: QuotaMemberRow[]
  backups: QuotaBackupRow[]
  markers: string[]
}

export type QuotaMigrationApplyResult = {
  state: QuotaMigrationState
  backedUp: number
  converted: number
  skippedBecauseMarker: boolean
}

export function applyMemberQuotaZeroToNull(state: QuotaMigrationState): QuotaMigrationApplyResult {
  if (state.markers.includes(MEMBER_QUOTA_ZERO_TO_NULL_MARKER)) {
    return { state, backedUp: 0, converted: 0, skippedBecauseMarker: true }
  }

  const backups = state.backups.map((row) => ({ ...row }))
  const backedUpIds = new Set(backups.map((row) => row.memberId))
  let backedUp = 0
  let converted = 0
  const members = state.members.map((member) => {
    if (member.quota !== 0) return { ...member }
    if (!backedUpIds.has(member.id)) {
      backups.push({
        id: member.id,
        memberId: member.id,
        organizationId: member.organizationId,
        userId: member.userId,
        oldQuota: 0,
      })
      backedUpIds.add(member.id)
      backedUp += 1
    }
    converted += 1
    return { ...member, quota: null }
  })

  return {
    state: {
      members,
      backups,
      markers: [...state.markers, MEMBER_QUOTA_ZERO_TO_NULL_MARKER],
    },
    backedUp,
    converted,
    skippedBecauseMarker: false,
  }
}

export function rollbackMemberQuotaZeroToNull(state: QuotaMigrationState): QuotaMigrationState {
  const backupByMember = new Map(state.backups.map((row) => [row.memberId, row]))
  return {
    members: state.members.map((member) => {
      const backup = backupByMember.get(member.id)
      if (!backup || member.quota !== null) return { ...member }
      return { ...member, quota: backup.oldQuota }
    }),
    backups: state.backups.map((row) => ({ ...row })),
    markers: state.markers.filter((name) => name !== MEMBER_QUOTA_ZERO_TO_NULL_MARKER),
  }
}
