import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyMemberQuotaZeroToNull,
  CREDITS_PER_CNY_SEED,
  MEMBER_QUOTA_ROLLBACK_CLEAR_MARKER,
  MEMBER_QUOTA_ROLLBACK_RESTORE,
  MEMBER_QUOTA_ZERO_TO_NULL_MARKER,
  MEMBER_QUOTA_ZERO_TO_NULL_STATEMENTS,
  rollbackMemberQuotaZeroToNull,
  type QuotaMigrationState,
} from '@/lib/billing/quota-migration'

const migrationSql = readFileSync(
  path.join(process.cwd(), 'prisma/migrations/20261028170000_credit_quota_ledger/migration.sql'),
  'utf8',
)
const rollbackSql = readFileSync(
  path.join(process.cwd(), 'prisma/migrations/20261028170000_credit_quota_ledger/rollback.sql'),
  'utf8',
)

function seeded(): QuotaMigrationState {
  return {
    members: [
      { id: 'zero', organizationId: 'org-1', userId: 'user-zero', quota: 0 },
      { id: 'ten', organizationId: 'org-1', userId: 'user-ten', quota: 10 },
      { id: 'open', organizationId: 'org-1', userId: 'user-open', quota: null },
      { id: 'half', organizationId: 'org-1', userId: 'user-half', quota: 0.5 },
    ],
    backups: [],
    markers: [],
  }
}

function quotaOf(state: QuotaMigrationState, id: string) {
  return state.members.find((member) => member.id === id)?.quota
}

describe('member quota 0 → null migration', () => {
  it('records the marker and changes nothing on an empty database', () => {
    const result = applyMemberQuotaZeroToNull({ members: [], backups: [], markers: [] })
    expect(result.backedUp).toBe(0)
    expect(result.converted).toBe(0)
    expect(result.state.backups).toEqual([])
    expect(result.state.markers).toEqual([MEMBER_QUOTA_ZERO_TO_NULL_MARKER])

    const again = applyMemberQuotaZeroToNull(result.state)
    expect(again.skippedBecauseMarker).toBe(true)
    expect(again.state).toBe(result.state)
  })

  it('converts only exact 0 quotas on a seeded database and keeps the backup', () => {
    const result = applyMemberQuotaZeroToNull(seeded())
    expect(result.converted).toBe(1)
    expect(result.backedUp).toBe(1)
    expect(quotaOf(result.state, 'zero')).toBeNull()
    expect(quotaOf(result.state, 'ten')).toBe(10)
    expect(quotaOf(result.state, 'open')).toBeNull()
    expect(quotaOf(result.state, 'half')).toBe(0.5)
    expect(result.state.backups).toEqual([
      {
        id: 'zero',
        memberId: 'zero',
        organizationId: 'org-1',
        userId: 'user-zero',
        oldQuota: 0,
      },
    ])
    expect(result.state.markers).toEqual([MEMBER_QUOTA_ZERO_TO_NULL_MARKER])
  })

  it('does nothing on re-run, including a 0 stored later to forbid a member', () => {
    const first = applyMemberQuotaZeroToNull(seeded())
    const withIntentionalDisable: QuotaMigrationState = {
      ...first.state,
      members: first.state.members.map((member) => (
        member.id === 'ten' ? { ...member, quota: 0 } : member
      )),
    }
    const second = applyMemberQuotaZeroToNull(withIntentionalDisable)
    expect(second.skippedBecauseMarker).toBe(true)
    expect(second.backedUp).toBe(0)
    expect(second.converted).toBe(0)
    expect(quotaOf(second.state, 'ten')).toBe(0)
    expect(second.state.backups).toHaveLength(1)
    expect(second.state).toBe(withIntentionalDisable)
  })

  it('restores only still-null quotas and a second rollback has no effect', () => {
    const migrated = applyMemberQuotaZeroToNull({
      ...seeded(),
      members: [
        ...seeded().members,
        { id: 'also-zero', organizationId: 'org-1', userId: 'user-also', quota: 0 },
      ],
    }).state
    const edited: QuotaMigrationState = {
      ...migrated,
      members: migrated.members.map((member) => (
        member.id === 'zero' ? { ...member, quota: 25 } : member
      )),
    }
    const rolled = rollbackMemberQuotaZeroToNull(edited)
    expect(quotaOf(rolled, 'zero')).toBe(25)
    expect(quotaOf(rolled, 'also-zero')).toBe(0)
    expect(quotaOf(rolled, 'ten')).toBe(10)
    expect(quotaOf(rolled, 'open')).toBeNull()
    expect(rolled.backups).toHaveLength(2)
    expect(rolled.markers).toEqual([])

    const again = rollbackMemberQuotaZeroToNull(rolled)
    expect(again.members).toEqual(rolled.members)
    expect(again.backups).toEqual(rolled.backups)
    expect(again.markers).toEqual([])
  })

  it('converts current zeros again after rollback removes the marker', () => {
    const migrated = applyMemberQuotaZeroToNull(seeded()).state
    const rolled = rollbackMemberQuotaZeroToNull(migrated)
    expect(quotaOf(rolled, 'zero')).toBe(0)
    const reapplied = applyMemberQuotaZeroToNull(rolled)
    expect(quotaOf(reapplied.state, 'zero')).toBeNull()
    expect(reapplied.backedUp).toBe(0)
    expect(reapplied.state.backups).toHaveLength(1)
  })

  it('keeps the SQL file in the same order as the idempotent statements', () => {
    let cursor = 0
    for (const statement of [...MEMBER_QUOTA_ZERO_TO_NULL_STATEMENTS, CREDITS_PER_CNY_SEED]) {
      const at = migrationSql.indexOf(statement, cursor)
      expect(at).toBeGreaterThanOrEqual(0)
      cursor = at + statement.length
    }
    expect(migrationSql.indexOf(MEMBER_QUOTA_ZERO_TO_NULL_STATEMENTS[0])).toBeLessThan(
      migrationSql.indexOf(MEMBER_QUOTA_ZERO_TO_NULL_STATEMENTS[1]),
    )
    expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS `credit_accounts`')
    expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS `credit_ledger_entries`')
    expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS `quota_allocation_logs`')
    expect(migrationSql).toContain('`arrears`')
    expect(rollbackSql.indexOf(MEMBER_QUOTA_ROLLBACK_RESTORE)).toBeGreaterThanOrEqual(0)
    expect(rollbackSql.indexOf(MEMBER_QUOTA_ROLLBACK_CLEAR_MARKER)).toBeGreaterThan(
      rollbackSql.indexOf(MEMBER_QUOTA_ROLLBACK_RESTORE),
    )
    expect(rollbackSql).toContain('WHERE m.`quota` IS NULL')
  })
})
