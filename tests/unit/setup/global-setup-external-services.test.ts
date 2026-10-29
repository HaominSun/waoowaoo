import { beforeEach, describe, expect, it, vi } from 'vitest'

const execSyncMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execSync: execSyncMock }))
vi.mock('mysql2/promise', () => ({
  default: {
    createConnection: vi.fn(async () => ({ query: vi.fn(async () => [[]]), end: vi.fn(async () => {}) })),
  },
}))
vi.mock('ioredis', () => ({
  default: class {
    status = 'ready'
    async connect() {}
    async ping() { return 'PONG' }
    disconnect() {}
  },
}))

import globalSetup from '../../setup/global-setup'
import { runGlobalTeardown } from '../../setup/global-teardown'

const ENV_KEYS = ['TEST_EXTERNAL_SERVICES', 'BILLING_TEST_BOOTSTRAP', 'SYSTEM_TEST_BOOTSTRAP', 'BILLING_TEST_KEEP_SERVICES', 'DATABASE_URL'] as const
const THROWAWAY_DATABASE_URL = 'mysql://root:root@127.0.0.1:3307/waoowaoo_test'
const MIGRATE_DEPLOY = 'npx prisma migrate deploy --schema prisma/schema.prisma'
const MIGRATE_RESET = 'npx prisma migrate reset --force --skip-seed --schema prisma/schema.prisma'

function commands() {
  return execSyncMock.mock.calls.map((call) => String(call[0]))
}

describe('global setup TEST_EXTERNAL_SERVICES switch', () => {
  beforeEach(() => {
    execSyncMock.mockReset()
    for (const key of ENV_KEYS) delete process.env[key]
    process.env.BILLING_TEST_BOOTSTRAP = '1'
    process.env.DATABASE_URL = THROWAWAY_DATABASE_URL
  })

  it('default: recreates docker compose services and applies migrations', async () => {
    const teardown = await globalSetup()
    expect(commands()).toEqual([
      'docker compose -f docker-compose.test.yml down -v --remove-orphans',
      'docker compose -f docker-compose.test.yml up -d --remove-orphans',
      MIGRATE_DEPLOY,
    ])
    execSyncMock.mockReset()
    await teardown()
    expect(commands()).toEqual(['docker compose -f docker-compose.test.yml down -v --remove-orphans'])
  })

  it('TEST_EXTERNAL_SERVICES=1: no docker, migrate reset, teardown keeps services', async () => {
    process.env.TEST_EXTERNAL_SERVICES = '1'
    process.env.DATABASE_URL = THROWAWAY_DATABASE_URL
    const teardown = await globalSetup()
    expect(commands()).toEqual([
      MIGRATE_RESET,
    ])
    execSyncMock.mockReset()
    await teardown()
    await runGlobalTeardown()
    expect(execSyncMock).not.toHaveBeenCalled()
  })

  it('no bootstrap flag: does nothing', async () => {
    delete process.env.BILLING_TEST_BOOTSTRAP
    process.env.TEST_EXTERNAL_SERVICES = '1'
    await globalSetup()
    expect(execSyncMock).not.toHaveBeenCalled()
  })

  it('external migrate reset proceeds when the database name ends with _test', async () => {
    process.env.TEST_EXTERNAL_SERVICES = '1'
    process.env.DATABASE_URL = 'mysql://root:root@127.0.0.1:3307/waoowaoo_test'
    await globalSetup()
    expect(commands()).toEqual([
      MIGRATE_RESET,
    ])
  })

  it('external migrate reset rejects database name waoowaoo', async () => {
    process.env.TEST_EXTERNAL_SERVICES = '1'
    process.env.DATABASE_URL = 'mysql://root:root@127.0.0.1:3307/waoowaoo'
    await expect(globalSetup()).rejects.toThrow('Refusing to force-reset database "waoowaoo"')
    expect(execSyncMock).not.toHaveBeenCalled()
  })

  it('external migrate reset rejects a missing DATABASE_URL', async () => {
    process.env.TEST_EXTERNAL_SERVICES = '1'
    delete process.env.DATABASE_URL
    await expect(globalSetup()).rejects.toThrow('DATABASE_URL is missing')
    expect(execSyncMock).not.toHaveBeenCalled()
  })

  it('external migrate reset rejects an unparseable DATABASE_URL', async () => {
    process.env.TEST_EXTERNAL_SERVICES = '1'
    process.env.DATABASE_URL = 'not-a-url'
    await expect(globalSetup()).rejects.toThrow('DATABASE_URL could not be parsed')
    expect(execSyncMock).not.toHaveBeenCalled()
  })

  it('external migrate reset ignores query params and proceeds for waoowaoo_test', async () => {
    process.env.TEST_EXTERNAL_SERVICES = '1'
    process.env.DATABASE_URL = 'mysql://root:root@127.0.0.1:3307/waoowaoo_test?connection_limit=5'
    await globalSetup()
    expect(commands()).toEqual([
      MIGRATE_RESET,
    ])
  })
})
