import { readFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import mysql from 'mysql2/promise'
import { Prisma } from '@prisma/client'
import { MEMBER_QUOTA_ZERO_TO_NULL_MARKER } from '@/lib/billing/quota-migration'
import { prisma } from '../../helpers/prisma'

const migrationPath = path.join(process.cwd(), 'prisma/migrations/20261028170000_credit_quota_ledger/migration.sql')
const rollbackPath = path.join(process.cwd(), 'prisma/migrations/20261028170000_credit_quota_ledger/rollback.sql')
const organizationId = randomUUID()
const suffix = organizationId.slice(0, 8)

const people = {
  zero: { id: randomUUID(), quota: 0, role: 'owner' },
  ten: { id: randomUUID(), quota: 10, role: 'member' },
  open: { id: randomUUID(), quota: null, role: 'member' },
  half: { id: randomUUID(), quota: 0.5, role: 'member' },
  alsoZero: { id: randomUUID(), quota: 0, role: 'member' },
  laterZero: { id: randomUUID(), quota: 0, role: 'member' },
} as const

function connectionOptions() {
  const url = new URL(process.env.DATABASE_URL || '')
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
    multipleStatements: true,
  }
}

async function runSqlFile(filePath: string) {
  const sql = readFileSync(filePath, 'utf8')
  const connection = await mysql.createConnection(connectionOptions())
  try {
    await connection.query(sql)
  } finally {
    await connection.end()
  }
}

async function quotaOf(userId: string) {
  const member = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  })
  if (!member) return undefined
  return member.quota === null ? null : Number(member.quota)
}

describe('quota 0 → null SQL migration', () => {
  let parkedZeroIds: string[] = []

  afterAll(async () => {
    await prisma.organizationMemberQuotaBackup.deleteMany({ where: { organizationId } })
    await prisma.organizationMember.deleteMany({ where: { organizationId } })
    await prisma.organizationBalance.deleteMany({ where: { organizationId } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.user.deleteMany({ where: { id: { in: Object.values(people).map((person) => person.id) } } })
    if (parkedZeroIds.length > 0) {
      await prisma.organizationMember.updateMany({
        where: { id: { in: parkedZeroIds } },
        data: { quota: 0 },
      })
    }
    await prisma.billingDataMigrationMarker.deleteMany({ where: { name: MEMBER_QUOTA_ZERO_TO_NULL_MARKER } })
  })

  it('runs on an empty quota set, then only converts seeded 0s, and re-runs without side effects', async () => {
    const preexisting = await prisma.organizationMember.findMany({
      where: { quota: new Prisma.Decimal(0) },
      select: { id: true },
    })
    parkedZeroIds = preexisting.map((member) => member.id)
    if (parkedZeroIds.length > 0) {
      await prisma.organizationMember.updateMany({
        where: { id: { in: parkedZeroIds } },
        data: { quota: 7 },
      })
    }
    await prisma.organizationMemberQuotaBackup.deleteMany()
    await prisma.billingDataMigrationMarker.deleteMany({ where: { name: MEMBER_QUOTA_ZERO_TO_NULL_MARKER } })

    await runSqlFile(migrationPath)

    expect(await prisma.organizationMemberQuotaBackup.count()).toBe(0)
    expect(await prisma.billingDataMigrationMarker.findUnique({
      where: { name: MEMBER_QUOTA_ZERO_TO_NULL_MARKER },
    })).not.toBeNull()
    expect(await prisma.systemConfig.count({ where: { key: 'credits_per_cny' } })).toBe(1)

    await prisma.billingDataMigrationMarker.deleteMany({ where: { name: MEMBER_QUOTA_ZERO_TO_NULL_MARKER } })
    await prisma.user.createMany({
      data: Object.entries(people).map(([key, person]) => ({
        id: person.id,
        name: `quota_${key}_${suffix}`,
      })),
    })
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: 'Quota migration',
        slug: `quota-mig-${suffix}`,
        ownerId: people.zero.id,
      },
    })
    await prisma.organizationMember.createMany({
      data: (['zero', 'ten', 'open', 'half', 'alsoZero'] as const).map((key) => ({
        id: randomUUID(),
        organizationId,
        userId: people[key].id,
        role: people[key].role,
        quota: people[key].quota,
      })),
    })

    await runSqlFile(migrationPath)

    expect(await quotaOf(people.zero.id)).toBeNull()
    expect(await quotaOf(people.alsoZero.id)).toBeNull()
    expect(await quotaOf(people.ten.id)).toBe(10)
    expect(await quotaOf(people.open.id)).toBeNull()
    expect(await quotaOf(people.half.id)).toBe(0.5)
    const backups = await prisma.organizationMemberQuotaBackup.findMany({ where: { organizationId } })
    expect(backups.map((row) => row.userId).sort()).toEqual([people.alsoZero.id, people.zero.id].sort())
    expect(backups.every((row) => Number(row.oldQuota) === 0)).toBe(true)

    await prisma.organizationMember.create({
      data: {
        organizationId,
        userId: people.laterZero.id,
        role: 'member',
        quota: 0,
      },
    })
    await runSqlFile(migrationPath)

    expect(await quotaOf(people.laterZero.id)).toBe(0)
    expect(await quotaOf(people.ten.id)).toBe(10)
    expect(await quotaOf(people.zero.id)).toBeNull()
    expect(await prisma.organizationMemberQuotaBackup.count({ where: { organizationId } })).toBe(2)
    expect(await prisma.systemConfig.count({ where: { key: 'credits_per_cny' } })).toBe(1)

    await prisma.organizationMember.update({
      where: { organizationId_userId: { organizationId, userId: people.zero.id } },
      data: { quota: 25 },
    })
    await runSqlFile(rollbackPath)

    expect(await quotaOf(people.zero.id)).toBe(25)
    expect(await quotaOf(people.alsoZero.id)).toBe(0)
    expect(await quotaOf(people.laterZero.id)).toBe(0)
    expect(await quotaOf(people.ten.id)).toBe(10)
    expect(await quotaOf(people.open.id)).toBeNull()
    expect(await prisma.billingDataMigrationMarker.findUnique({
      where: { name: MEMBER_QUOTA_ZERO_TO_NULL_MARKER },
    })).toBeNull()
    expect(await prisma.organizationMemberQuotaBackup.count({ where: { organizationId } })).toBe(2)

    await runSqlFile(rollbackPath)
    expect(await quotaOf(people.alsoZero.id)).toBe(0)
    expect(await quotaOf(people.zero.id)).toBe(25)

    await runSqlFile(migrationPath)
    expect(await quotaOf(people.alsoZero.id)).toBeNull()
    expect(await quotaOf(people.laterZero.id)).toBeNull()
    expect(await quotaOf(people.zero.id)).toBe(25)
    expect(await quotaOf(people.ten.id)).toBe(10)
  })
})