import { afterEach, describe, expect, it } from 'vitest'
import {
  CursorSecretError,
  decodeListCursor,
  encodeListCursor,
  type ListFilterSet,
} from '@/lib/pagination/keyset-cursor'

const filters: ListFilterSet = {
  resource: 'assets',
  userId: 'user-1',
  folderId: null,
  q: null,
  kind: 'character',
  scope: 'global',
  projectId: null,
}

const previous = {
  NODE_ENV: process.env.NODE_ENV,
  NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
  AUTH_SECRET: process.env.AUTH_SECRET,
}

const env = process.env as Record<string, string | undefined>

function setEnv(input: { nodeEnv?: string; nextAuth?: string; auth?: string }) {
  if (input.nodeEnv === undefined) delete env.NODE_ENV
  else env.NODE_ENV = input.nodeEnv
  if (input.nextAuth === undefined) delete env.NEXTAUTH_SECRET
  else env.NEXTAUTH_SECRET = input.nextAuth
  if (input.auth === undefined) delete env.AUTH_SECRET
  else env.AUTH_SECRET = input.auth
}

afterEach(() => {
  env.NODE_ENV = previous.NODE_ENV
  if (previous.NEXTAUTH_SECRET === undefined) delete env.NEXTAUTH_SECRET
  else env.NEXTAUTH_SECRET = previous.NEXTAUTH_SECRET
  if (previous.AUTH_SECRET === undefined) delete env.AUTH_SECRET
  else env.AUTH_SECRET = previous.AUTH_SECRET
})

describe('asset list cursor secret', () => {
  it.each(['production', 'staging', undefined])('throws when NODE_ENV is %s and no signing secret is configured', (nodeEnv) => {
    setEnv({ nodeEnv })
    const createdAt = new Date('2024-01-01T00:00:00.000Z')
    expect(() => encodeListCursor({ createdAt, id: 'asset-1' }, filters)).toThrow(CursorSecretError)
    expect(() => decodeListCursor('not-a-cursor', filters)).toThrow(CursorSecretError)
  })

  it('signs cursors in production when NEXTAUTH_SECRET is set', () => {
    setEnv({ nodeEnv: 'production', nextAuth: 'production-cursor-secret' })
    const createdAt = new Date('2024-01-01T00:00:00.123Z')
    const token = encodeListCursor({ createdAt, id: 'asset-1' }, filters)
    expect(decodeListCursor(token, filters)).toEqual({ createdAt, id: 'asset-1' })

    setEnv({ nodeEnv: 'production', nextAuth: 'different-secret' })
    expect(() => decodeListCursor(token, filters)).toThrow(/Invalid cursor/)
  })

  it('accepts a stable AUTH_SECRET when NEXTAUTH_SECRET is unset in production', () => {
    setEnv({ nodeEnv: 'production', auth: 'auth-secret-fallback' })
    const createdAt = new Date('2024-03-01T00:00:00.000Z')
    const token = encodeListCursor({ createdAt, id: 'asset-2' }, filters)
    expect(decodeListCursor(token, filters).id).toBe('asset-2')
  })

  it.each(['test', 'development'])('uses a process-local secret in %s when no secret is configured', (nodeEnv) => {
    setEnv({ nodeEnv })
    const createdAt = new Date('2024-02-01T00:00:00.000Z')
    const token = encodeListCursor({ createdAt, id: 'asset-dev' }, filters)
    expect(decodeListCursor(token, filters)).toEqual({ createdAt, id: 'asset-dev' })
    expect(() => decodeListCursor(`${token}x`, filters)).toThrow(/Invalid cursor/)
  })

  it('rejects a cursor minted for a different user', () => {
    setEnv({ nodeEnv: 'test', nextAuth: 'shared-test-secret' })
    const createdAt = new Date('2024-04-01T00:00:00.000Z')
    const token = encodeListCursor({ createdAt, id: 'asset-1' }, filters)
    expect(() => decodeListCursor(token, { ...filters, userId: 'user-2' })).toThrow(/Cursor does not match the current filters/)
  })
})
