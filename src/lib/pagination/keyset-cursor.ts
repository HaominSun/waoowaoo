import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { ApiError } from '@/lib/api-errors'

export const LIST_PAGE_DEFAULT_LIMIT = 24
export const LIST_PAGE_MAX_LIMIT = 100
const LIST_QUERY_MAX_LENGTH = 200
const CURSOR_TOKEN_MAX_LENGTH = 4096
const CURSOR_VERSION = 1

export type ListCursorResource = 'assets' | 'styles'

/** Filters bound into the cursor. A cursor is only valid for the same set. */
export type ListFilterSet = {
  resource: ListCursorResource
  folderId: string | null
  q: string | null
  kind: string | null
  scope: string | null
  projectId: string | null
}

export type DecodedListCursor = {
  createdAt: Date
  id: string
}

export type EnabledListPage = {
  enabled: true
  limit: number
  q: string | null
  cursor: DecodedListCursor | null
  filters: ListFilterSet
}

export type ParsedListPage =
  | { enabled: false }
  | EnabledListPage

type CursorBody = {
  v: number
  t: string
  id: string
  fh: string
  sig: string
}

// Used only when NEXTAUTH_SECRET / AUTH_SECRET is unset. Signatures then stay valid for this process.
const ephemeralCursorSecret = randomBytes(32).toString('hex')

function cursorSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET?.trim() || process.env.AUTH_SECRET?.trim()
  return secret && secret.length > 0 ? secret : ephemeralCursorSecret
}

export function normalizeSearchText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function hashListFilters(filters: ListFilterSet): string {
  const canonical = [
    filters.resource,
    filters.folderId ?? '',
    filters.q ?? '',
    filters.kind ?? '',
    filters.scope ?? '',
    filters.projectId ?? '',
  ].join('\n')
  return createHash('sha256').update(canonical).digest('hex')
}

function signCursor(payload: { v: number; t: string; id: string; fh: string }): string {
  return createHmac('sha256', cursorSecret())
    .update(`${payload.v}\n${payload.t}\n${payload.id}\n${payload.fh}`)
    .digest('base64url')
}

function signaturesMatch(actual: string, expected: string): boolean {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  if (left.length === 0 || left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function throwInvalidCursor(): never {
  throw new ApiError('INVALID_PARAMS', { message: 'Invalid cursor' })
}

function throwFilterMismatch(): never {
  throw new ApiError('INVALID_PARAMS', { message: 'Cursor does not match the current filters' })
}

export function encodeListCursor(
  input: { createdAt: Date; id: string },
  filters: ListFilterSet,
): string {
  const body = {
    v: CURSOR_VERSION,
    t: input.createdAt.toISOString(),
    id: input.id,
    fh: hashListFilters(filters),
  }
  const signed: CursorBody = { ...body, sig: signCursor(body) }
  return Buffer.from(JSON.stringify(signed), 'utf8').toString('base64url')
}

function isCursorBody(value: unknown): value is CursorBody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const body = value as Partial<CursorBody>
  return body.v === CURSOR_VERSION
    && typeof body.t === 'string'
    && typeof body.id === 'string'
    && body.id.length > 0
    && body.id.length <= 191
    && typeof body.fh === 'string'
    && body.fh.length > 0
    && typeof body.sig === 'string'
    && body.sig.length > 0
}

function decodeListCursorUnchecked(token: string, filters: ListFilterSet): DecodedListCursor {
  if (token.length === 0 || token.length > CURSOR_TOKEN_MAX_LENGTH) throwInvalidCursor()
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
  } catch {
    throwInvalidCursor()
  }
  if (!isCursorBody(parsed)) throwInvalidCursor()
  const expectedSig = signCursor({ v: parsed.v, t: parsed.t, id: parsed.id, fh: parsed.fh })
  if (!signaturesMatch(parsed.sig, expectedSig)) throwInvalidCursor()
  if (parsed.fh !== hashListFilters(filters)) throwFilterMismatch()
  const createdAt = new Date(parsed.t)
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== parsed.t) throwInvalidCursor()
  return { createdAt, id: parsed.id }
}

export function decodeListCursor(token: string, filters: ListFilterSet): DecodedListCursor {
  try {
    return decodeListCursorUnchecked(token, filters)
  } catch (error) {
    if (error instanceof ApiError) throw error
    throwInvalidCursor()
  }
}

/**
 * Invalid limits are rejected (not clamped): missing, 0, negative, above 100,
 * and any non-canonical integer (decimals, exponents, leading zeros, signs).
 */
export function parseLimit(raw: string): number {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new ApiError('INVALID_PARAMS', { message: 'limit must be an integer between 1 and 100' })
  }
  const limit = Number(raw)
  if (!Number.isSafeInteger(limit) || limit > LIST_PAGE_MAX_LIMIT) {
    throw new ApiError('INVALID_PARAMS', { message: 'limit must be an integer between 1 and 100' })
  }
  return limit
}

export function parseListPage(input: {
  cursor: string | null
  limit: string | null
  q: string | null
  filters: Omit<ListFilterSet, 'q'>
}): ParsedListPage {
  if (input.cursor === null && input.limit === null) {
    return { enabled: false }
  }

  const q = normalizeSearchText(input.q)
  if (q && q.length > LIST_QUERY_MAX_LENGTH) {
    throw new ApiError('INVALID_PARAMS', { message: 'q must be at most 200 characters' })
  }
  const filters: ListFilterSet = { ...input.filters, q }
  const limit = input.limit === null ? LIST_PAGE_DEFAULT_LIMIT : parseLimit(input.limit.trim())

  let cursor: DecodedListCursor | null = null
  if (input.cursor !== null) {
    const token = input.cursor.trim()
    if (!token) throwInvalidCursor()
    cursor = decodeListCursor(token, filters)
  }

  return { enabled: true, limit, q, cursor, filters }
}

export function keysetWhere(cursor: DecodedListCursor | null): {
  OR: [
    { createdAt: { lt: Date } },
    { AND: [{ createdAt: Date }, { id: { lt: string } }] },
  ]
} | Record<string, never> {
  if (!cursor) return {}
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { AND: [{ createdAt: cursor.createdAt }, { id: { lt: cursor.id } }] },
    ],
  }
}

export const KEYSET_ORDER_BY = [
  { createdAt: 'desc' as const },
  { id: 'desc' as const },
]

/** LIKE fragment for Prisma `contains`. Escapes `\`, `%`, and `_`. */
export function escapeLikeFragment(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

export function nameContains(q: string | null): { contains: string } | undefined {
  if (!q) return undefined
  return { contains: escapeLikeFragment(q) }
}

type KeyedRow<T> = {
  createdAt: Date
  id: string
  value: T
}

function compareKeysetDesc(left: { createdAt: Date; id: string }, right: { createdAt: Date; id: string }): number {
  const time = right.createdAt.getTime() - left.createdAt.getTime()
  if (time !== 0) return time
  if (left.id === right.id) return 0
  return left.id < right.id ? 1 : -1
}

/**
 * Each group must already be the next `limit + 1` rows of one table.
 * The global top `limit + 1` rows are contained in that union.
 */
export function mergeKeysetRows<T>(
  groups: Array<Array<KeyedRow<T>>>,
  limit: number,
  filters: ListFilterSet,
): { items: T[]; nextCursor: string | null } {
  const merged = groups.flat().sort(compareKeysetDesc)
  const hasMore = merged.length > limit
  const page = hasMore ? merged.slice(0, limit) : merged
  const last = page[page.length - 1]
  return {
    items: page.map((row) => row.value),
    nextCursor: hasMore && last
      ? encodeListCursor({ createdAt: last.createdAt, id: last.id }, filters)
      : null,
  }
}

export function sliceKeysetRows<T extends { createdAt: Date; id: string }>(
  rows: T[],
  limit: number,
  filters: ListFilterSet,
): { page: T[]; nextCursor: string | null } {
  const merged = mergeKeysetRows(
    [rows.map((row) => ({ createdAt: row.createdAt, id: row.id, value: row }))],
    limit,
    filters,
  )
  return { page: merged.items, nextCursor: merged.nextCursor }
}
