/**
 * Baseline a database that was created with `prisma db push` before the
 * credit-quota migration.
 *
 * Rehearse on a copy of production first.
 *
 *   npx tsx scripts/migrate-baseline-check.ts --dry-run
 *   npx tsx scripts/migrate-baseline-check.ts
 *
 * Compares the live database to prisma/baseline/schema.pre-credit-quota.prisma
 * (the datamodel at the merge-base before #8). An empty diff marks every
 * migration except 20261028170000_credit_quota_ledger as applied, so
 * `prisma migrate deploy` runs only that migration. A non-empty diff marks
 * nothing, prints the diff, and exits non-zero. After a real mark, the same
 * diff is run again and must still be empty.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import mysql from 'mysql2/promise'

export const CREDIT_QUOTA_MIGRATION = '20261028170000_credit_quota_ledger'
export const PRE_CREDIT_SCHEMA = 'prisma/baseline/schema.pre-credit-quota.prisma'

const ROOT = process.cwd()

export type DiffResult = {
  exitCode: number
  output: string
}

export type BaselineCheckDeps = {
  dryRun: boolean
  migrationNames: string[]
  applied: Set<string>
  diff: () => DiffResult
  resolveApplied: (name: string) => void
  stdout: (line: string) => void
  stderr: (line: string) => void
}

export function assertDroppableTestDatabase(name: string): void {
  if (!name.endsWith('_test')) {
    const shown = name || '(empty)'
    throw new Error(
      `Refusing to drop database "${shown}": database name must end with "_test". Point this test at a throwaway test database.`,
    )
  }
}

export function databaseNameFromUrl(dbUrl: string | undefined): string {
  if (!dbUrl?.trim()) {
    throw new Error(
      'Refusing to drop database: DATABASE_URL is missing. Only a database whose name ends with "_test" may be dropped.',
    )
  }
  try {
    const url = new URL(dbUrl)
    const segment = url.pathname.replace(/^\/+/, '').split('/')[0] ?? ''
    const database = segment ? decodeURIComponent(segment) : ''
    assertDroppableTestDatabase(database)
    return database
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Refusing to drop')) throw error
    throw new Error(
      'Refusing to drop database: DATABASE_URL could not be parsed. Only a database whose name ends with "_test" may be dropped.',
    )
  }
}

export function listMigrationNames(root = ROOT): string[] {
  const dir = path.join(root, 'prisma/migrations')
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(dir, entry.name, 'migration.sql')))
    .map((entry) => entry.name)
    .sort()
}

export function historicalMigrations(names: string[]): string[] {
  return names.filter((name) => name !== CREDIT_QUOTA_MIGRATION).sort()
}

export function runBaselineCheck(deps: BaselineCheckDeps): number {
  const pending = historicalMigrations(deps.migrationNames).filter((name) => !deps.applied.has(name))
  if (pending.length === 0) {
    deps.stdout('Bootstrap migrations already recorded. Nothing to mark.\n')
    return 0
  }

  const first = deps.diff()
  const firstKind = classifyDiff(first)
  if (firstKind === 'error') {
    deps.stderr(first.output)
    deps.stderr(`prisma migrate diff failed with exit ${first.exitCode}. This is a diff error, not a schema mismatch. Marked nothing.\n`)
    return 1
  }
  if (firstKind === 'mismatch') {
    deps.stderr(first.output)
    deps.stderr('Live database does not match prisma/baseline/schema.pre-credit-quota.prisma (migrate diff exit 2). Marked nothing.\n')
    return 2
  }

  if (deps.dryRun) {
    for (const name of pending) deps.stdout(`${name}: would mark applied (dry-run).\n`)
    deps.stdout('Dry-run: no migrations were marked.\n')
    return 0
  }

  for (const name of pending) {
    deps.resolveApplied(name)
    deps.stdout(`${name}: marked applied.\n`)
  }

  const second = deps.diff()
  const secondKind = classifyDiff(second)
  if (secondKind !== 'empty') {
    deps.stderr(second.output)
    if (secondKind === 'error') {
      deps.stderr(`Post-mark prisma migrate diff failed with exit ${second.exitCode}. This is a diff error, not a schema mismatch.\n`)
    } else {
      deps.stderr('Post-mark migrate diff is not empty (exit 2).\n')
    }
    deps.stderr(`${recoveryInstructions(pending)}\n`)
    return secondKind === 'mismatch' ? 2 : 1
  }
  deps.stdout(`Marked ${pending.length} migrations applied. prisma migrate deploy will run only ${CREDIT_QUOTA_MIGRATION}.\n`)
  return 0
}

function classifyDiff(result: DiffResult): 'empty' | 'mismatch' | 'error' {
  if (result.exitCode === 0) return 'empty'
  if (result.exitCode === 2) return 'mismatch'
  return 'error'
}

const MIGRATION_NAME = /^\d{14}_[a-z0-9_]+$/

export function assertSafeMigrationName(name: string): void {
  if (!MIGRATION_NAME.test(name)) {
    throw new Error(
      `Refusing to print a DELETE for migration name "${name}": name must match /^\\d{14}_[a-z0-9_]+$/.`,
    )
  }
}

export function recoveryInstructions(migrationNames: string[]): string {
  for (const name of migrationNames) assertSafeMigrationName(name)
  const quoted = migrationNames.map((name) => `  '${name}'`).join(',\n')
  return [
    'This run already inserted these _prisma_migrations rows. Delete only these rows, then fix the copy before retrying:',
    'DELETE FROM `_prisma_migrations`',
    'WHERE `migration_name` IN (',
    quoted,
    ');',
    'See prisma/migrations/BOOTSTRAP.md.',
  ].join('\n')
}

function databaseName(dbUrl: string): string {
  const url = new URL(dbUrl)
  const segment = url.pathname.replace(/^\/+/, '').split('/')[0] ?? ''
  if (!segment) throw new Error('DATABASE_URL has no database name')
  return decodeURIComponent(segment)
}

async function listApplied(dbUrl: string): Promise<Set<string>> {
  const connection = await mysql.createConnection(dbUrl)
  try {
    const [rows] = await connection.query(
      `SELECT migration_name AS migrationName
       FROM _prisma_migrations
       WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    )
    return new Set((rows as Array<{ migrationName: string }>).map((row) => row.migrationName))
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? (error as { code?: string }).code
      : undefined
    if (code === 'ER_NO_SUCH_TABLE') return new Set()
    throw error
  } finally {
    await connection.end()
  }
}

function migrateDiff(databaseUrl: string): DiffResult {
  const result = spawnSync('npx', [
    'prisma', 'migrate', 'diff',
    '--from-url', databaseUrl,
    '--to-schema-datamodel', PRE_CREDIT_SCHEMA,
    '--exit-code',
    '--script',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: databaseUrl },
  })
  return {
    exitCode: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

function resolveApplied(databaseUrl: string, name: string): void {
  const result = spawnSync('npx', [
    'prisma', 'migrate', 'resolve', '--applied', name, '--schema', 'prisma/schema.prisma',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: databaseUrl },
  })
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `migrate resolve failed for ${name}`)
  }
}

async function main(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl?.trim()) {
    process.stderr.write('DATABASE_URL is required. Rehearse on a copy of production first.\n')
    return 1
  }
  // Touch the name so a missing database segment fails before diff.
  databaseName(databaseUrl)
  const applied = await listApplied(databaseUrl)
  return runBaselineCheck({
    dryRun: process.argv.includes('--dry-run'),
    migrationNames: listMigrationNames(),
    applied,
    diff: () => migrateDiff(databaseUrl),
    resolveApplied: (name) => resolveApplied(databaseUrl, name),
    stdout: (line) => process.stdout.write(line),
    stderr: (line) => process.stderr.write(line),
  })
}

const isDirectRun = process.argv[1]?.endsWith('migrate-baseline-check.ts')
  || process.argv[1]?.endsWith('migrate-baseline-check.js')
if (isDirectRun) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`[migrate-baseline-check] FAILED: ${message}\n`)
      process.exitCode = 1
    })
}
