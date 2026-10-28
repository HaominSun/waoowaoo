import { execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import mysql from 'mysql2/promise'
import Redis from 'ioredis'
import { loadTestEnv } from './env'
import { isExternalTestServices, runGlobalTeardown } from './global-teardown'

function parseDbUrl(dbUrl: string) {
  const url = new URL(dbUrl)
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
  }
}

async function waitForMysql(maxAttempts = 180) {
  const db = parseDbUrl(process.env.DATABASE_URL || '')

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const conn = await mysql.createConnection({
        host: db.host,
        port: db.port,
        user: db.user,
        password: db.password,
        database: db.database,
        connectTimeout: 5_000,
      })
      await conn.query('SELECT 1')
      await conn.end()
      return
    } catch {
      await sleep(1_000)
    }
  }

  throw new Error('MySQL test service did not become ready in time')
}

async function waitForRedis(maxAttempts = 60) {
  const redis = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || '6380'),
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  })

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        if (redis.status !== 'ready') {
          await redis.connect()
        }
        const pong = await redis.ping()
        if (pong === 'PONG') return
      } catch {
        await sleep(1_000)
      }
    }
  } finally {
    redis.disconnect()
  }

  throw new Error('Redis test service did not become ready in time')
}

export default async function globalSetup() {
  loadTestEnv()

  const shouldBootstrap = process.env.BILLING_TEST_BOOTSTRAP === '1' || process.env.SYSTEM_TEST_BOOTSTRAP === '1'
  if (!shouldBootstrap) {
    return async () => {}
  }

  // TEST_EXTERNAL_SERVICES=1: MySQL/Redis are provided externally (e.g. CI service
  // containers or a local install). Skip docker compose entirely; only wait for
  // DATABASE_URL / REDIS_HOST:REDIS_PORT, then reset schema+data ourselves
  // (the docker path gets a clean DB from `down -v`).
  const external = isExternalTestServices()

  if (!external) {
    execSync('docker compose -f docker-compose.test.yml down -v --remove-orphans', {
      cwd: process.cwd(),
      stdio: 'inherit',
    })

    execSync('docker compose -f docker-compose.test.yml up -d --remove-orphans', {
      cwd: process.cwd(),
      stdio: 'inherit',
    })
  }

  await waitForMysql()
  await waitForRedis()

  const pushCmd = external
    ? 'npx prisma db push --skip-generate --force-reset --accept-data-loss --schema prisma/schema.prisma'
    : 'npx prisma db push --skip-generate --schema prisma/schema.prisma'
  execSync(pushCmd, {
    cwd: process.cwd(),
    stdio: 'inherit',
  })

  return async () => {
    await runGlobalTeardown()
  }
}
