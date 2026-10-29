import { execFileSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import mysql from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2/promise'

const database = 'waoowaoo_migrate_empty'

function adminConfig() {
  const url = new URL(process.env.DATABASE_URL || 'mysql://root:root@127.0.0.1:3307/waoowaoo_test')
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