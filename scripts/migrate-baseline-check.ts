/**
 * Decide which bootstrap migrations an existing database may mark applied.
 *
 * Rehearse on a copy of production first. The script never blanket-marks.
 * A migration is resolved only when every table and column it introduces is
 * present and matches. If the structure is only partly there, or a column
 * type/nullability differs, the process exits non-zero and marks nothing.
 *
 *   npx tsx scripts/migrate-baseline-check.ts --dry-run
 *   npx tsx scripts/migrate-baseline-check.ts
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import mysql from 'mysql2/promise'

export const BOOTSTRAP_MIGRATIONS = [
  '20260301000000_baseline',
  '20260625120000_create_organization_base',
  '20261028160000_platform_admin_schema',
] as const

export type BootstrapMigrationName = (typeof BOOTSTRAP_MIGRATIONS)[number]

export type ExpectedColumn = {
  name: string
  columnType: string
  nullable: boolean
}

export type ExpectedTable = {
  name: string
  columns: ExpectedColumn[]
}

export type ExpectedMigration = {
  name: string
  tables: ExpectedTable[]
  addedColumns: Array<ExpectedColumn & { table: string }>
}

export type ActualColumn = {
  columnType: string
  nullable: boolean
}

export type ActualSchema = Map<string, Map<string, ActualColumn>>

export type MigrationVerdict =
  | { status: 'absent' }
  | { status: 'complete' }
  | { status: 'partial'; details: string[] }
  | { status: 'mismatch'; details: string[] }

const ROOT = process.cwd()

export function canonicalColumnType(type: string): string {
  let normalized = type.toLowerCase().replace(/\s+/g, '')
  normalized = normalized.replace(/^integer$/, 'int')
  normalized = normalized.replace(/^boolean$/, 'tinyint(1)')
  normalized = normalized.replace(/^int\(\d+\)$/, 'int')
  normalized = normalized.replace(/^bigint\(\d+\)$/, 'bigint')
  return normalized
}

export function parseMigrationSql(sql: string): Omit<ExpectedMigration, 'name'> {
  const tables: ExpectedTable[] = []
  const addedColumns: Array<ExpectedColumn & { table: string }> = []
  const createRe = /CREATE TABLE\s+`([^`]+)`\s*\(/gi
  let match = createRe.exec(sql)
  while (match) {
    const name = match[1]
    const bodyStart = match.index + match[0].length
    const body = readBalanced(sql, bodyStart - 1)
    tables.push({ name, columns: parseColumnLines(body) })
    match = createRe.exec(sql)
  }

  const alterRe = /ALTER TABLE\s+`([^`]+)`([\s\S]*?);/gi
  let alter = alterRe.exec(sql)
  while (alter) {
    const table = alter[1]
    const addRe = /ADD COLUMN\s+`([^`]+)`\s+([^,;]+)/gi
    let column = addRe.exec(alter[2])
    while (column) {
      addedColumns.push({ table, ...parseColumnDef(column[1], column[2]) })
      column = addRe.exec(alter[2])
    }
    alter = alterRe.exec(sql)
  }

  return { tables, addedColumns }
}

export function evaluateMigration(expected: Omit<ExpectedMigration, 'name'>, actual: ActualSchema): MigrationVerdict {
  const missingTables = expected.tables.filter((table) => !actual.has(table.name)).map((table) => `missing table ${table.name}`)
  const presentTables = expected.tables.filter((table) => actual.has(table.name))
  const missingAdds = expected.addedColumns
    .filter((column) => !actual.get(column.table)?.has(column.name))
    .map((column) => `missing column ${column.table}.${column.name}`)
  const presentAdds = expected.addedColumns.filter((column) => actual.get(column.table)?.has(column.name))
  const introduced = expected.tables.length + expected.addedColumns.length
  const presentCount = presentTables.length + presentAdds.length

  if (introduced === 0) {
    return { status: 'mismatch', details: ['migration SQL declares no tables or columns'] }
  }
  if (presentCount === 0) return { status: 'absent' }
  if (missingTables.length > 0 || missingAdds.length > 0) {
    return { status: 'partial', details: [...missingTables, ...missingAdds] }
  }

  const mismatches: string[] = []
  for (const table of presentTables) {
    const columns = actual.get(table.name)
    for (const column of table.columns) {
      const found = columns?.get(column.name)
      if (!found) {
        mismatches.push(`missing column ${table.name}.${column.name}`)
        continue
      }
      mismatches.push(...diffColumn(`${table.name}.${column.name}`, column, found))
    }
  }
  for (const column of presentAdds) {
    const found = actual.get(column.table)?.get(column.name)
    if (!found) continue
    mismatches.push(...diffColumn(`${column.table}.${column.name}`, column, found))
  }
  if (mismatches.length > 0) return { status: 'mismatch', details: mismatches }
  return { status: 'complete' }
}

function diffColumn(label: string, expected: ExpectedColumn, actual: ActualColumn): string[] {
  const problems: string[] = []
  if (canonicalColumnType(actual.columnType) !== expected.columnType) {
    problems.push(`${label} type is ${actual.columnType}, expected ${expected.columnType}`)
  }
  if (actual.nullable !== expected.nullable) {
    problems.push(`${label} nullability is ${actual.nullable ? 'NULL' : 'NOT NULL'}`)
  }
  return problems
}

function parseColumnLines(body: string): ExpectedColumn[] {
  const columns: ExpectedColumn[] = []
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim().replace(/,\s*$/, '')
    if (!line.startsWith('`')) continue
    const parsed = /^`([^`]+)`\s+([\s\S]+)$/.exec(line)
    if (!parsed) continue
    columns.push(parseColumnDef(parsed[1], parsed[2]))
  }
  return columns
}

function parseColumnDef(name: string, definition: string): ExpectedColumn {
  const nullable = !/\bNOT NULL\b/i.test(definition)
  const type = definition
    .replace(/\bNOT NULL\b/i, '')
    .replace(/\bNULL\b/i, '')
    .replace(/\bDEFAULT\b[\s\S]*$/i, '')
    .trim()
  return { name, columnType: canonicalColumnType(type), nullable }
}

function readBalanced(sql: string, openParenIndex: number): string {
  let depth = 0
  for (let index = openParenIndex; index < sql.length; index += 1) {
    const char = sql[index]
    if (char === '(') depth += 1
    if (char === ')') {
      depth -= 1
      if (depth === 0) return sql.slice(openParenIndex + 1, index)
    }
  }
  throw new Error('Unbalanced CREATE TABLE in migration SQL')
}

export function loadBootstrapExpectations(root = ROOT): ExpectedMigration[] {
  return BOOTSTRAP_MIGRATIONS.map((name) => ({
    name,
    ...parseMigrationSql(readFileSync(path.join(root, 'prisma/migrations', name, 'migration.sql'), 'utf8')),
  }))
}

type ColumnRow = {
  tableName: string
  columnName: string
  columnType: string
  isNullable: 'YES' | 'NO'
}

export function schemaFromRows(rows: ColumnRow[]): ActualSchema {
  const schema: ActualSchema = new Map()
  for (const row of rows) {
    let columns = schema.get(row.tableName)
    if (!columns) {
      columns = new Map()
      schema.set(row.tableName, columns)
    }
    columns.set(row.columnName, {
      columnType: row.columnType,
      nullable: row.isNullable === 'YES',
    })
  }
  return schema
}

function databaseName(dbUrl: string): string {
  const url = new URL(dbUrl)
  const segment = url.pathname.replace(/^\/+/, '').split('/')[0] ?? ''
  if (!segment) throw new Error('DATABASE_URL has no database name')
  return decodeURIComponent(segment)
}

async function loadActualSchema(dbUrl: string): Promise<{ schema: ActualSchema; applied: Set<string> }> {
  const connection = await mysql.createConnection(dbUrl)
  try {
    const schemaName = databaseName(dbUrl)
    const [columnRows] = await connection.query(
      `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName, COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ?`,
      [schemaName],
    )
    let applied = new Set<string>()
    try {
      const [appliedRows] = await connection.query(
        `SELECT migration_name AS migrationName
         FROM _prisma_migrations
         WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
      )
      applied = new Set((appliedRows as Array<{ migrationName: string }>).map((row) => row.migrationName))
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? (error as { code?: string }).code
        : undefined
      if (code !== 'ER_NO_SUCH_TABLE') throw error
    }
    return {
      schema: schemaFromRows(columnRows as ColumnRow[]),
      applied,
    }
  } finally {
    await connection.end()
  }
}

function report(name: string, verdict: MigrationVerdict) {
  if (verdict.status === 'absent') {
    process.stdout.write(`${name}: absent. Leave it for prisma migrate deploy.\n`)
    return
  }
  if (verdict.status === 'complete') {
    process.stdout.write(`${name}: complete.\n`)
    return
  }
  process.stdout.write(`${name}: ${verdict.status}\n`)
  for (const detail of verdict.details) process.stdout.write(`  - ${detail}\n`)
}

async function main() {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl?.trim()) {
    process.stderr.write('DATABASE_URL is required. Rehearse on a copy of production first.\n')
    process.exitCode = 1
    return
  }
  const dryRun = process.argv.includes('--dry-run')
  const expectations = loadBootstrapExpectations()
  const { schema, applied } = await loadActualSchema(dbUrl)
  const verdicts = expectations.map((expected) => ({
    name: expected.name,
    verdict: evaluateMigration(expected, schema),
  }))
  let failed = false
  for (const item of verdicts) {
    report(item.name, item.verdict)
    if (item.verdict.status === 'partial' || item.verdict.status === 'mismatch') failed = true
  }
  if (failed) {
    process.stderr.write('Refusing to mark migrations. Structure is partial or does not match. Fix the copy before migrate deploy.\n')
    process.exitCode = 1
    return
  }
  for (const item of verdicts) {
    if (item.verdict.status !== 'complete') continue
    if (applied.has(item.name)) {
      process.stdout.write(`${item.name}: already recorded in _prisma_migrations.\n`)
      continue
    }
    if (dryRun) {
      process.stdout.write(`${item.name}: would mark applied (dry-run).\n`)
      continue
    }
    execFileSync('npx', ['prisma', 'migrate', 'resolve', '--applied', item.name], {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    })
    process.stdout.write(`${item.name}: marked applied.\n`)
  }
}

const isDirectRun = process.argv[1]?.endsWith('migrate-baseline-check.ts')
  || process.argv[1]?.endsWith('migrate-baseline-check.js')
if (isDirectRun) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[migrate-baseline-check] FAILED: ${message}\n`)
    process.exitCode = 1
  })
}
