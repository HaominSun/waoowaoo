import { spawnSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import mysql from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2/promise'
import {
  CREDIT_QUOTA_MIGRATION,
  assertDroppableTestDatabase,
  databaseNameFromUrl,
  listMigrationNames,
} from '../../../scripts/migrate-baseline-check'

const deployDatabase = 'waoowaoo_baseline_deploy_test'
const pushDatabase = 'waoowaoo_baseline_push_test'
const brokenDatabase = 'waoowaoo_baseline_broken_test'

function requireDatabaseUrl(): URL {
  const source = databaseNameFromUrl(process.env.DATABASE_URL)
  assertDroppableTestDatabase(source)
  return new URL(process.env.DATABASE_URL as string)
}

function adminConfig() {
  const url = requireDatabaseUrl()
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  }
}

function databaseUrl(name: string): string {
  assertDroppableTestDatabase(name)
  const admin = adminConfig()
  return `mysql://${encodeURIComponent(admin.user)}:${encodeURIComponent(admin.password)}@${admin.host}:${admin.port}/${name}`
}

async function recreate(name: string) {
  assertDroppableTestDatabase(name)
  const connection = await mysql.createConnection(adminConfig())
  try {
    await connection.query(`DROP DATABASE IF EXISTS \`${name}\``)
    await connection.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
  } finally {
    await connection.end()
  }
}

async function drop(name: string) {
  assertDroppableTestDatabase(name)
  const connection = await mysql.createConnection(adminConfig())
  try {
    await connection.query(`DROP DATABASE IF EXISTS \`${name}\``)
  } finally {
    await connection.end()
  }
}

function runChecker(name: string, dryRun: boolean) {
  const args = ['tsx', 'scripts/migrate-baseline-check.ts']
  if (dryRun) args.push('--dry-run')
  return spawnSync('npx', args, {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: databaseUrl(name) },
  })
}

async function appliedMigrations(name: string): Promise<string[]> {
  const connection = await mysql.createConnection(databaseUrl(name))
  try {
    const [rows] = await connection.query<RowDataPacket[]>(
      'SELECT migration_name AS migrationName FROM _prisma_migrations ORDER BY migration_name',
    )
    return rows.map((row) => String(row.migrationName))
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? (error as { code?: string }).code
      : undefined
    if (code === 'ER_NO_SUCH_TABLE') return []
    throw error
  } finally {
    await connection.end()
  }
}

describe('migrate baseline check against MySQL', () => {
  afterAll(async () => {
    await drop(deployDatabase)
    await drop(pushDatabase)
    await drop(brokenDatabase)
  })

  it('is a no-op on a database built by migrate deploy', async () => {
    await recreate(deployDatabase)
    const deploy = spawnSync('npx', ['prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: databaseUrl(deployDatabase) },
    })
    expect(deploy.status, deploy.stderr).toBe(0)
    const before = await appliedMigrations(deployDatabase)

    const check = runChecker(deployDatabase, false)
    expect(check.status, `${check.stdout}\n${check.stderr}`).toBe(0)
    expect(check.stdout).toContain('Nothing to mark')
    expect(await appliedMigrations(deployDatabase)).toEqual(before)
  }, 120_000)

  it('dry-run writes nothing and a real run marks every migration except credit-quota', async () => {
    await recreate(pushDatabase)
    const push = spawnSync('npx', [
      'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss',
      '--schema', 'prisma/baseline/schema.pre-credit-quota.prisma',
    ], {
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: databaseUrl(pushDatabase) },
    })
    expect(push.status, push.stderr).toBe(0)

    const dryRun = runChecker(pushDatabase, true)
    expect(dryRun.status, `${dryRun.stdout}\n${dryRun.stderr}`).toBe(0)
    expect(dryRun.stdout).toContain('Dry-run: no migrations were marked.')
    expect(await appliedMigrations(pushDatabase)).toEqual([])

    const real = runChecker(pushDatabase, false)
    expect(real.status, `${real.stdout}\n${real.stderr}`).toBe(0)
    const marked = await appliedMigrations(pushDatabase)
    const historical = listMigrationNames().filter((name) => name !== CREDIT_QUOTA_MIGRATION)
    expect(marked).toEqual(historical)
    expect(marked).not.toContain(CREDIT_QUOTA_MIGRATION)

    const deploy = spawnSync('npx', ['prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: databaseUrl(pushDatabase) },
    })
    expect(deploy.status, `${deploy.stdout}\n${deploy.stderr}`).toBe(0)
    expect(deploy.stdout).toContain(CREDIT_QUOTA_MIGRATION)
    expect(await appliedMigrations(pushDatabase)).toContain(CREDIT_QUOTA_MIGRATION)
  }, 180_000)

  it('marks nothing and exits non-zero when an index is missing', async () => {
    await recreate(brokenDatabase)
    const push = spawnSync('npx', [
      'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss',
      '--schema', 'prisma/baseline/schema.pre-credit-quota.prisma',
    ], {
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: databaseUrl(brokenDatabase) },
    })
    expect(push.status, push.stderr).toBe(0)
    const connection = await mysql.createConnection(databaseUrl(brokenDatabase))
    try {
      await connection.query('ALTER TABLE `admin_audit_logs` DROP INDEX `admin_audit_logs_createdAt_idx`')
    } finally {
      await connection.end()
    }

    const check = runChecker(brokenDatabase, false)
    expect(check.status).not.toBe(0)
    expect(`${check.stdout}${check.stderr}`).toContain('admin_audit_logs_createdAt_idx')
    expect(`${check.stdout}${check.stderr}`).toContain('Marked nothing.')
    expect(await appliedMigrations(brokenDatabase)).toEqual([])
  }, 120_000)
})
