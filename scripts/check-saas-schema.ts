import { prisma } from '@/lib/prisma'

type ColumnCheck = {
  table: string
  column: string
}

type IndexCheck = {
  table: string
  index: string
  columns: string[]
}

type CountRow = {
  c: bigint | number
}

type IndexRow = {
  columnName: string
  seqInIndex: bigint | number
}

const REQUIRED_TABLES = [
  'organizations',
  'organization_members',
  'organization_balances',
  'organization_usages',
  'pricing_plans',
  'plan_entitlements',
  'organization_subscriptions',
  'billing_orders',
  'billing_invoices',
  'organization_invitations',
  'enterprise_audit_logs',
  'credit_accounts',
  'quota_allocation_logs',
  'credit_ledger_entries',
  'organization_member_quota_zero_backup',
  'billing_data_migration_markers',
] as const

const REQUIRED_COLUMNS: ColumnCheck[] = [
  { table: 'projects', column: 'organizationId' },
  { table: 'usage_costs', column: 'organizationId' },
  { table: 'organizations', column: 'businessStatus' },
  { table: 'organizations', column: 'settings' },
  { table: 'organizations', column: 'currentPlanId' },
  { table: 'organizations', column: 'currentSubscriptionId' },
  { table: 'organization_members', column: 'quotaUsed' },
  { table: 'organization_balances', column: 'arrears' },
  { table: 'organization_members', column: 'updatedAt' },
  { table: 'organization_usages', column: 'planCreditAmount' },
  { table: 'organization_usages', column: 'balanceAmount' },
  { table: 'organization_usages', column: 'taskId' },
  { table: 'organization_usages', column: 'orderId' },
  { table: 'organization_usages', column: 'metadata' },
  { table: 'organization_usages', column: 'idempotencyKey' },
  { table: 'tasks', column: 'organizationId' },
  { table: 'user_preferences', column: 'currentOrganizationId' },
]

const REQUIRED_INDEXES: IndexCheck[] = [
  {
    table: 'organization_usages',
    index: 'organization_usages_org_idempotency_key',
    columns: ['organizationId', 'idempotencyKey'],
  },
]

async function existsTable(table: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<CountRow[]>`
    SELECT COUNT(*) AS c
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ${table}
  `
  return Number(rows[0]?.c || 0) > 0
}

async function existsColumn(table: string, column: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<CountRow[]>`
    SELECT COUNT(*) AS c
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ${table}
      AND COLUMN_NAME = ${column}
  `
  return Number(rows[0]?.c || 0) > 0
}

async function hasIndex(check: IndexCheck): Promise<boolean> {
  const rows = await prisma.$queryRaw<IndexRow[]>`
    SELECT COLUMN_NAME AS columnName, SEQ_IN_INDEX AS seqInIndex
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ${check.table}
      AND INDEX_NAME = ${check.index}
    ORDER BY SEQ_IN_INDEX ASC
  `
  return rows.map((row) => row.columnName).join('|') === check.columns.join('|')
}

async function hasDefaultPlan(): Promise<boolean> {
  if (!(await existsTable('pricing_plans'))) return false
  const rows = await prisma.$queryRaw<CountRow[]>`
    SELECT COUNT(*) AS c
    FROM pricing_plans
    WHERE id = 'plan_free_default'
  `
  return Number(rows[0]?.c || 0) > 0
}

async function main() {
  const missing: string[] = []

  for (const table of REQUIRED_TABLES) {
    if (!(await existsTable(table))) {
      missing.push(`table:${table}`)
    }
  }

  for (const { table, column } of REQUIRED_COLUMNS) {
    if (!(await existsColumn(table, column))) {
      missing.push(`column:${table}.${column}`)
    }
  }

  for (const check of REQUIRED_INDEXES) {
    if (!(await hasIndex(check))) {
      missing.push(`index:${check.table}.${check.index}`)
    }
  }

  if (!(await hasDefaultPlan())) {
    missing.push('seed:pricing_plans.plan_free_default')
  }

  if (missing.length > 0) {
    process.stderr.write(`[check-saas-schema] Missing database objects:\n${missing.map((item) => `- ${item}`).join('\n')}\n`)
    process.stderr.write('[check-saas-schema] Run `npx prisma migrate deploy` on a migration-managed database, or `npx prisma db push --skip-generate` for local development databases.\n')
    process.exitCode = 1
    return
  }

  process.stdout.write('[check-saas-schema] OK: SaaS platform database schema is compatible.\n')
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[check-saas-schema] FAILED: ${message}\n`)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
