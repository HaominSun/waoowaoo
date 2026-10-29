import { describe, expect, it } from 'vitest'
import {
  CREDIT_QUOTA_MIGRATION,
  assertDroppableTestDatabase,
  databaseNameFromUrl,
  historicalMigrations,
  runBaselineCheck,
  type DiffResult,
} from '../../../scripts/migrate-baseline-check'

const migrations = [
  '20260301000000_baseline',
  '20260625120000_create_organization_base',
  '20261028160000_platform_admin_schema',
  CREDIT_QUOTA_MIGRATION,
]

function emptyDiff(): DiffResult {
  return { exitCode: 0, output: '-- This is an empty migration.\n' }
}

function run(overrides: Partial<Parameters<typeof runBaselineCheck>[0]> = {}) {
  const resolved: string[] = []
  const out: string[] = []
  const err: string[] = []
  const diffs: DiffResult[] = []
  const code = runBaselineCheck({
    dryRun: false,
    migrationNames: migrations,
    applied: new Set(),
    diff: () => diffs.shift() ?? emptyDiff(),
    resolveApplied: (name) => resolved.push(name),
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    ...overrides,
  })
  return { code, resolved, out: out.join(''), err: err.join('') }
}

describe('migrate baseline check', () => {
  it('refuses to drop a database whose name does not end with _test', () => {
    expect(() => assertDroppableTestDatabase('waoowaoo')).toThrow(/_test/)
    expect(() => assertDroppableTestDatabase('')).toThrow(/_test/)
    expect(() => databaseNameFromUrl('mysql://root:root@127.0.0.1:3307/waoowaoo')).toThrow(/_test/)
    expect(() => databaseNameFromUrl(undefined)).toThrow(/missing/)
    expect(() => databaseNameFromUrl('not-a-url')).toThrow(/parsed/)
    expect(databaseNameFromUrl('mysql://root:root@127.0.0.1:3307/waoowaoo_test?connection_limit=5')).toBe('waoowaoo_test')
    expect(() => assertDroppableTestDatabase('waoowaoo_migrate_test')).not.toThrow()
  })

  it('does not call resolve and exits 2 when the pre-#8 diff is a schema mismatch', () => {
    const result = run({
      diff: () => ({ exitCode: 2, output: 'DROP INDEX `projects_userId_idx` ON `projects`;\n' }),
    })
    expect(result.code).toBe(2)
    expect(result.resolved).toEqual([])
    expect(result.err).toContain('projects_userId_idx')
    expect(result.err).toContain('exit 2')
    expect(result.err).toContain('Marked nothing')
    expect(result.err).not.toContain('diff error')
  })

  it('exits 1 and marks nothing when prisma migrate diff itself fails', () => {
    const result = run({
      diff: () => ({ exitCode: 1, output: 'Error: P1001 Can\'t reach database server\n' }),
    })
    expect(result.code).toBe(1)
    expect(result.resolved).toEqual([])
    expect(result.err).toContain('P1001')
    expect(result.err).toContain('exit 1')
    expect(result.err).toContain('diff error, not a schema mismatch')
    expect(result.err).toContain('Marked nothing')
  })

  it('marks only the historical migrations that are not already recorded', () => {
    const result = run({
      applied: new Set(['20260301000000_baseline']),
    })
    expect(result.code).toBe(0)
    expect(result.resolved).toEqual([
      '20260625120000_create_organization_base',
      '20261028160000_platform_admin_schema',
    ])
    expect(result.resolved).not.toContain(CREDIT_QUOTA_MIGRATION)
  })

  it('dry-run writes nothing when the diff is empty', () => {
    const result = run({ dryRun: true })
    expect(result.code).toBe(0)
    expect(result.resolved).toEqual([])
    expect(result.out).toContain('would mark applied')
    expect(result.out).toContain('Dry-run: no migrations were marked.')
    expect(result.out).not.toContain(CREDIT_QUOTA_MIGRATION)
  })

  it('marks every migration except the credit-quota one when the diff is empty', () => {
    const result = run()
    expect(result.code).toBe(0)
    expect(result.resolved).toEqual(historicalMigrations(migrations))
    expect(result.resolved).not.toContain(CREDIT_QUOTA_MIGRATION)
  })

  it('is a no-op when those migrations are already recorded', () => {
    let diffCalls = 0
    const result = run({
      applied: new Set(historicalMigrations(migrations)),
      diff: () => {
        diffCalls += 1
        return emptyDiff()
      },
    })
    expect(result.code).toBe(0)
    expect(result.resolved).toEqual([])
    expect(diffCalls).toBe(0)
    expect(result.out).toContain('Nothing to mark')
  })

  it('exits non-zero when the post-mark diff is not empty', () => {
    const calls: DiffResult[] = [
      emptyDiff(),
      { exitCode: 2, output: 'ALTER TABLE `projects` ADD COLUMN `mode` VARCHAR(191) NULL;\n' },
    ]
    const result = run({
      diff: () => calls.shift() ?? emptyDiff(),
    })
    expect(result.code).toBe(2)
    expect(result.resolved).toEqual(historicalMigrations(migrations))
    expect(result.err).toContain('Post-mark migrate diff is not empty (exit 2).')
    expect(result.err).toContain('DELETE FROM `_prisma_migrations`')
    for (const name of historicalMigrations(migrations)) {
      expect(result.err).toContain(`'${name}'`)
    }
    expect(result.err).not.toContain(`'${CREDIT_QUOTA_MIGRATION}'`)
  })
})
