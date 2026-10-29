import fs from 'node:fs'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import mysql from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { KEYSET_ORDER_BY, keysetWhere, nameContains } from '@/lib/pagination/keyset-cursor'

const enabled = process.env.TEST_EXTERNAL_SERVICES === '1'
const DATABASE_NAME = 'waoowaoo_asset_list_pagination_test'

function databaseNameFromUrl(raw: string): string {
  const url = new URL(raw)
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''))
  return name
}

function assertTestDatabaseName(name: string): void {
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing MySQL integration test against "${name}"; database name must end with _test`)
  }
}

function migrationStatements(): string[] {
  const file = path.resolve(process.cwd(), 'prisma/migrations/20261028153000_add_asset_list_pagination_indexes/migration.sql')
  return fs.readFileSync(file, 'utf8')
    .split(';')
    .map((part) => part.replace(/--[^\n]*/g, '').trim())
    .filter((part) => part.length > 0)
}

describe.skipIf(!enabled)('mysql integration - asset list keyset pagination', () => {
  let admin: mysql.Connection
  let db: PrismaClient
  const userId = 'user-mysql-1'

  beforeAll(async () => {
    const raw = process.env.DATABASE_URL
    if (!raw) throw new Error('DATABASE_URL is required when TEST_EXTERNAL_SERVICES=1')
    assertTestDatabaseName(databaseNameFromUrl(raw))
    assertTestDatabaseName(DATABASE_NAME)

    const url = new URL(raw)
    admin = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    })
    await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE_NAME}\``)
    await admin.query(`CREATE DATABASE \`${DATABASE_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    await admin.changeUser({ database: DATABASE_NAME })

    await admin.query(`
      CREATE TABLE global_characters (
        id VARCHAR(191) NOT NULL,
        userId VARCHAR(191) NOT NULL,
        folderId VARCHAR(191) NULL,
        name VARCHAR(191) NOT NULL,
        aliases TEXT NULL,
        profileData TEXT NULL,
        profileConfirmed BOOLEAN NOT NULL DEFAULT false,
        voiceId VARCHAR(191) NULL,
        voiceType VARCHAR(191) NULL,
        customVoiceUrl TEXT NULL,
        customVoiceMediaId VARCHAR(191) NULL,
        globalVoiceId VARCHAR(191) NULL,
        createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        INDEX global_characters_userId_idx (userId),
        INDEX global_characters_folderId_idx (folderId)
      )
    `)
    await admin.query(`
      CREATE TABLE global_locations (
        id VARCHAR(191) NOT NULL,
        userId VARCHAR(191) NOT NULL,
        folderId VARCHAR(191) NULL,
        createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id)
      )
    `)
    await admin.query(`
      CREATE TABLE global_voices (
        id VARCHAR(191) NOT NULL,
        userId VARCHAR(191) NOT NULL,
        folderId VARCHAR(191) NULL,
        createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id)
      )
    `)

    for (const statement of migrationStatements()) {
      await admin.query(statement)
    }

    const testUrl = new URL(raw)
    testUrl.pathname = `/${DATABASE_NAME}`
    db = new PrismaClient({ datasources: { db: { url: testUrl.toString() } } })
  }, 60_000)

  afterAll(async () => {
    await db?.$disconnect()
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE_NAME}\``)
      await admin.end()
    }
  })

  it('applies the (userId, folderId, createdAt) indexes from the migration', async () => {
    const [rows] = await admin.query(
      `SELECT TABLE_NAME AS tableName, SEQ_IN_INDEX AS seq, COLUMN_NAME AS columnName
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ? AND INDEX_NAME LIKE '%userId_folderId_createdAt_idx'
       ORDER BY TABLE_NAME, SEQ_IN_INDEX`,
      [DATABASE_NAME],
    )
    const indexes = rows as Array<{ tableName: string; seq: number; columnName: string }>
    expect(indexes.map((row) => `${row.tableName}.${row.seq}:${row.columnName}`)).toEqual([
      'global_characters.1:userId',
      'global_characters.2:folderId',
      'global_characters.3:createdAt',
      'global_locations.1:userId',
      'global_locations.2:folderId',
      'global_locations.3:createdAt',
      'global_voices.1:userId',
      'global_voices.2:folderId',
      'global_voices.3:createdAt',
    ])
  })

  it('orders millisecond timestamps and breaks same-millisecond ties by id desc', async () => {
    const tie = new Date('2024-06-01T00:00:00.123Z')
    const earlierMs = new Date('2024-06-01T00:00:00.122Z')
    const later = new Date('2024-06-01T00:00:01.000Z')
    for (const row of [
      { id: 'id-b', createdAt: tie },
      { id: 'id-a', createdAt: tie },
      { id: 'id-c', createdAt: earlierMs },
      { id: 'id-d', createdAt: later },
    ]) {
      await db.globalCharacter.create({
        data: {
          id: row.id,
          userId,
          name: row.id,
          createdAt: row.createdAt,
          updatedAt: row.createdAt,
        },
      })
    }

    const ordered = await db.globalCharacter.findMany({
      where: { userId },
      orderBy: [...KEYSET_ORDER_BY],
    })
    expect(ordered.map((row) => row.id)).toEqual(['id-d', 'id-b', 'id-a', 'id-c'])
    expect(ordered.find((row) => row.id === 'id-b')?.createdAt.toISOString()).toBe(tie.toISOString())

    const afterLater = await db.globalCharacter.findMany({
      where: { userId, ...keysetWhere({ createdAt: later, id: 'id-d' }) },
      orderBy: [...KEYSET_ORDER_BY],
    })
    expect(afterLater.map((row) => row.id)).toEqual(['id-b', 'id-a', 'id-c'])

    const afterTie = await db.globalCharacter.findMany({
      where: { userId, ...keysetWhere({ createdAt: tie, id: 'id-b' }) },
      orderBy: [...KEYSET_ORDER_BY],
    })
    expect(afterTie.map((row) => row.id)).toEqual(['id-a', 'id-c'])
  })

  it('searches literal % _ and backslash without double-escaping LIKE', async () => {
    const createdAt = new Date('2024-07-01T00:00:00.001Z')
    await db.globalCharacter.create({
      data: { id: 'literal', userId, name: '100%_ready', createdAt, updatedAt: createdAt },
    })
    await db.globalCharacter.create({
      data: { id: 'wildcard', userId, name: '100ABready', createdAt, updatedAt: createdAt },
    })
    await db.globalCharacter.create({
      data: { id: 'slash', userId, name: 'a\\b', createdAt, updatedAt: createdAt },
    })

    const literal = await db.globalCharacter.findMany({
      where: { userId, name: nameContains('100%_ready') },
    })
    expect(literal.map((row) => row.id)).toEqual(['literal'])

    const slash = await db.globalCharacter.findMany({
      where: { userId, name: nameContains('a\\b') },
    })
    expect(slash.map((row) => row.id)).toEqual(['slash'])
  })
})
