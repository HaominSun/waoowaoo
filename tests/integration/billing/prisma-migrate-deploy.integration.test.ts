import { execFileSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import mysql from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2/promise'

const database = 'waoowaoo_migrate_test'

/**
 * Dropping a database is destructive. Same rule as the external-service
 * force-reset guard: the database name (URL path, query string ignored)
 * must end with `_test`.
 */
function assertTestDatabaseName(name: string) {
  if (!name.endsWith('_test')) {
    const shown = name || '(empty)'
    throw new Error(
      `Refusing to drop database "${shown}": database name must end with "_test". Point this test at a throwaway test database.`,
    )
  }
}

function requireDatabaseUrl(): URL {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl?.trim()) {
    throw new Error(
      'Refusing to drop database: DATABASE_URL is missing. Only a database whose name ends with "_test" may be dropped.',
    )
  }
  try {
    const url = new URL(dbUrl)
    const segment = url.pathname.replace(/^\/+/, '').split('/')[0] ?? ''
    const sourceDatabase = segment ? decodeURIComponent(segment) : ''
    assertTestDatabaseName(sourceDatabase)
    return url
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Refusing to drop')) throw error
    throw new Error(
      'Refusing to drop database: DATABASE_URL could not be parsed. Only a database whose name ends with "_test" may be dropped.',
    )
  }
}

function adminConfig() {
  const url = requireDatabaseUrl()
  assertTestDatabaseName(database)
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  }
}

function emptyDatabaseUrl() {
  const admin = adminConfig()
  return `mysql://${encodeURIComponent(admin.user)}:${encodeURIComponent(admin.password)}@${admin.host}:${admin.port}/${database}`
}

describe('prisma migrate deploy on an empty database', () => {
  afterAll(async () => {
    const connection = await mysql.createConnection(adminConfig())
    try {
      await connection.query(`DROP DATABASE IF EXISTS \`${database}\``)
    } finally {
      await connection.end()
    }
  })

  it('applies the full migration history and matches schema.prisma', async () => {
    const connection = await mysql.createConnection(adminConfig())
    try {
      await connection.query(`DROP DATABASE IF EXISTS \`${database}\``)
      await connection.query(
        `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      )
    } finally {
      await connection.end()
    }

    execFileSync('bash', ['scripts/ci/prisma-migrate-deploy-empty.sh'], {
      env: { ...process.env, DATABASE_URL: emptyDatabaseUrl() },
      stdio: 'inherit',
    })

    const check = await mysql.createConnection({ ...adminConfig(), database })
    try {
      const [markerRows] = await check.query<RowDataPacket[]>(
        'SELECT name FROM billing_data_migration_markers WHERE name = ?',
        ['organization_member_quota_0_to_null'],
      )
      const [configRows] = await check.query<RowDataPacket[]>(
        'SELECT value FROM system_configs WHERE `key` = ?',
        ['credits_per_cny'],
      )
      const [ledgerTables] = await check.query<RowDataPacket[]>(
        `SELECT TABLE_NAME AS tableName FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'credit_ledger_entries'`,
        [database],
      )
      expect(markerRows).toHaveLength(1)
      expect(configRows[0]?.value).toBe('1')
      expect(ledgerTables).toHaveLength(1)
    } finally {
      await check.end()
    }
  })
})