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

const ENV_KEYS = ['TEST_EXTERNAL_SERVICES', 'BILLING_TEST_BOOTSTRAP', 'SYSTEM_TEST_BOOTSTRAP', 'BILLING_TEST_KEEP_SERVICES'] as const

function commands() {
  return execSyncMock.mock.calls.map((call) => String(call[0]))
}

describe('global setup TEST_EXTERNAL_SERVICES switch', () => {
  beforeEach(() => {
    execSyncMock.mockReset()
    for (const key of ENV_KEYS) delete process.env[key]
    process.env.BILLING_TEST_BOOTSTRAP = '1'
  })

  it('default: recreates docker compose services and pushes schema', async () => {
    const teardown = await globalSetup()
    expect(commands()).toEqual([
      'docker compose -f docker-compose.test.yml down -v --remove-orphans',
      'docker compose -f docker-compose.test.yml up -d --remove-orphans',
      'npx prisma db push --skip-generate --schema prisma/schema.prisma',
    ])
    execSyncMock.mockReset()
    await teardown()
    expect(commands()).toEqual(['docker compose -f docker-compose.test.yml down -v --remove-orphans'])
  })

  it('TEST_EXTERNAL_SERVICES=1: no docker, force-reset schema, teardown keeps services', async () => {
    process.env.TEST_EXTERNAL_SERVICES = '1'
    const teardown = await globalSetup()
    expect(commands()).toEqual([
      'npx prisma db push --skip-generate --force-reset --accept-data-loss --schema prisma/schema.prisma',
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
})
