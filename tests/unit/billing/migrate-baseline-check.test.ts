import { describe, expect, it } from 'vitest'
import {
  evaluateMigration,
  loadBootstrapExpectations,
  parseMigrationSql,
  schemaFromRows,
  type ActualSchema,
} from '../../../scripts/migrate-baseline-check'

function schema(rows: Array<[string, string, string, boolean]>): ActualSchema {
  return schemaFromRows(rows.map(([tableName, columnName, columnType, nullable]) => ({
    tableName,
    columnName,
    columnType,
    isNullable: nullable ? 'YES' : 'NO',
  })))
}

const orgSql = `
CREATE TABLE \`organizations\` (
    \`id\` VARCHAR(191) NOT NULL,
    \`slug\` VARCHAR(191) NOT NULL,
    PRIMARY KEY (\`id\`)
);
CREATE TABLE \`organization_members\` (
    \`id\` VARCHAR(191) NOT NULL,
    \`quota\` DECIMAL(18, 6) NULL,
    PRIMARY KEY (\`id\`)
);
`

describe('migrate baseline checker', () => {
  const expectations = loadBootstrapExpectations()

  it('reads the three bootstrap migrations from disk', () => {
    expect(expectations.map((item) => item.name)).toEqual([
      '20260301000000_baseline',
      '20260625120000_create_organization_base',
      '20261028160000_platform_admin_schema',
    ])
    const baseline = expectations[0]
    const orgBase = expectations[1]
    const platform = expectations[2]
    expect(baseline.tables.some((table) => table.name === 'account')).toBe(true)
    expect(baseline.tables.some((table) => table.name === 'organizations')).toBe(false)
    expect(orgBase.tables.map((table) => table.name)).toEqual([
      'organizations',
      'organization_members',
      'organization_balances',
      'organization_usages',
    ])
    expect(platform.tables.map((table) => table.name)).toEqual(['admin_audit_logs', 'system_configs'])
    expect(platform.addedColumns.map((column) => `${column.table}.${column.name}`)).toEqual([
      'user.isGlobalLocked',
      'user.isPlatformAdmin',
    ])
  })

  it('leaves a migration unmarked when none of its tables exist', () => {
    const expected = parseMigrationSql(orgSql)
    expect(evaluateMigration(expected, schema([]))).toEqual({ status: 'absent' })
  })

  it('accepts a full match and ignores columns added by later migrations', () => {
    const expected = parseMigrationSql(orgSql)
    const actual = schema([
      ['organizations', 'id', 'varchar(191)', false],
      ['organizations', 'slug', 'varchar(191)', false],
      ['organizations', 'businessStatus', 'varchar(191)', false],
      ['organization_members', 'id', 'varchar(191)', false],
      ['organization_members', 'quota', 'decimal(18,6)', true],
    ])
    expect(evaluateMigration(expected, actual)).toEqual({ status: 'complete' })
  })

  it('treats MySQL boolean and integer types as the migration types', () => {
    const expected = parseMigrationSql(`
      CREATE TABLE \`flags\` (
        \`id\` INTEGER NOT NULL,
        \`on\` BOOLEAN NOT NULL,
        PRIMARY KEY (\`id\`)
      );
    `)
    const actual = schema([
      ['flags', 'id', 'int', false],
      ['flags', 'on', 'tinyint(1)', false],
    ])
    expect(evaluateMigration(expected, actual)).toEqual({ status: 'complete' })
  })

  it('errors when only some tables exist', () => {
    const expected = parseMigrationSql(orgSql)
    const actual = schema([
      ['organizations', 'id', 'varchar(191)', false],
      ['organizations', 'slug', 'varchar(191)', false],
    ])
    const verdict = evaluateMigration(expected, actual)
    expect(verdict.status).toBe('partial')
    if (verdict.status === 'partial') {
      expect(verdict.details).toContain('missing table organization_members')
    }
  })

  it('errors when a table exists but a declared column does not match', () => {
    const expected = parseMigrationSql(orgSql)
    const wrongType = schema([
      ['organizations', 'id', 'varchar(191)', false],
      ['organizations', 'slug', 'varchar(64)', false],
      ['organization_members', 'id', 'varchar(191)', false],
      ['organization_members', 'quota', 'decimal(18,6)', true],
    ])
    expect(evaluateMigration(expected, wrongType).status).toBe('mismatch')

    const missingColumn = schema([
      ['organizations', 'id', 'varchar(191)', false],
      ['organization_members', 'id', 'varchar(191)', false],
      ['organization_members', 'quota', 'decimal(18,6)', true],
    ])
    const verdict = evaluateMigration(expected, missingColumn)
    expect(verdict.status).toBe('mismatch')
    if (verdict.status === 'mismatch') {
      expect(verdict.details.some((line) => line.includes('organizations.slug'))).toBe(true)
    }
  })

  it('errors when a platform-admin column is missing while its tables exist', () => {
    const platform = expectations[2]
    const rows: Array<[string, string, string, boolean]> = []
    for (const table of platform.tables) {
      for (const column of table.columns) {
        rows.push([table.name, column.name, column.columnType, column.nullable])
      }
    }
    rows.push(['user', 'isGlobalLocked', 'tinyint(1)', false])
    const verdict = evaluateMigration(platform, schema(rows))
    expect(verdict.status).toBe('partial')
    if (verdict.status === 'partial') {
      expect(verdict.details).toContain('missing column user.isPlatformAdmin')
    }
  })
})
