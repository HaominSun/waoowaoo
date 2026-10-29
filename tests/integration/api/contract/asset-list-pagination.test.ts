import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMockRequest } from '../../../helpers/request'
import { attachMediaFieldsToGlobalCharacter, attachMediaFieldsToGlobalLocation, attachMediaFieldsToGlobalVoice, attachMediaFieldsToProject } from '@/lib/media/attach'
import {
  mapGlobalCharacterToAsset,
  mapGlobalLocationToAsset,
  mapGlobalPropToAsset,
  mapGlobalVoiceToAsset,
  mapProjectCharacterToAsset,
  mapProjectLocationToAsset,
  mapProjectPropToAsset,
} from '@/lib/assets/mappers'
import { GET as getAssets } from '@/app/api/assets/route'
import { GET as getStyles } from '@/app/api/asset-hub/styles/route'

type Row = Record<string, unknown>
type OrderSpec = Record<string, 'asc' | 'desc'>
type QueryArgs = {
  where?: Row
  orderBy?: OrderSpec | OrderSpec[]
  take?: number
  include?: Row
  select?: Row
}

const { state, prismaMock } = vi.hoisted(() => {
  const state = {
    userId: 'user-1',
    characters: [] as Row[],
    locations: [] as Row[],
    voices: [] as Row[],
    styles: [] as Row[],
    projects: [] as Row[],
    projectCharacters: [] as Row[],
    projectLocations: [] as Row[],
    sql: [] as string[],
  }

  function isRecord(value: unknown): value is Row {
    return !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
  }

  function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  function likeContains(value: string, pattern: string): boolean {
    let source = ''
    for (let index = 0; index < pattern.length; index += 1) {
      const char = pattern[index] ?? ''
      if (char === '\\' && index + 1 < pattern.length) {
        source += escapeRegex(pattern[index + 1] ?? '')
        index += 1
        continue
      }
      if (char === '%') source += '[\\s\\S]*'
      else if (char === '_') source += '[\\s\\S]'
      else source += escapeRegex(char)
    }
    return new RegExp(source, 'i').test(value)
  }

  function matches(row: Row, where: Row | undefined): boolean {
    if (!where) return true
    for (const [key, expected] of Object.entries(where)) {
      if (key === 'AND') {
        if (!Array.isArray(expected) || !expected.every((part) => isRecord(part) && matches(row, part))) return false
        continue
      }
      if (key === 'OR') {
        if (!Array.isArray(expected) || !expected.some((part) => isRecord(part) && matches(row, part))) return false
        continue
      }
      const actual = row[key]
      if (expected instanceof Date) {
        if (!(actual instanceof Date) || actual.getTime() !== expected.getTime()) return false
        continue
      }
      if (isRecord(expected)) {
        if ('contains' in expected) {
          if (typeof actual !== 'string' || typeof expected.contains !== 'string' || !likeContains(actual, expected.contains)) return false
          continue
        }
        if ('lt' in expected) {
          const bound = expected.lt
          if (actual instanceof Date && bound instanceof Date) {
            if (!(actual.getTime() < bound.getTime())) return false
            continue
          }
          if (typeof actual === 'string' && typeof bound === 'string') {
            if (!(actual < bound)) return false
            continue
          }
          return false
        }
        throw new Error(`Unsupported filter for ${key}: ${Object.keys(expected).join(',')}`)
      }
      if (actual !== expected) return false
    }
    return true
  }

  function compareValue(left: unknown, right: unknown): number {
    if (left instanceof Date && right instanceof Date) return left.getTime() - right.getTime()
    if (typeof left === 'string' && typeof right === 'string') {
      if (left === right) return 0
      return left < right ? -1 : 1
    }
    return 0
  }

  function compareRows(orderBy: OrderSpec | OrderSpec[] | undefined) {
    const specs = !orderBy ? [] : Array.isArray(orderBy) ? orderBy : [orderBy]
    return (left: Row, right: Row) => {
      for (const spec of specs) {
        const field = Object.keys(spec)[0]
        if (!field) continue
        const direction = spec[field]
        const cmp = compareValue(left[field], right[field])
        if (cmp !== 0) return direction === 'desc' ? -cmp : cmp
      }
      return 0
    }
  }

  function withInclude(row: Row, include?: Row): Row {
    if (!include) return row
    const copy: Row = { ...row }
    for (const key of ['appearances', 'images'] as const) {
      if (!include[key] || !Array.isArray(row[key])) continue
      const nested = include[key]
      const orderBy = isRecord(nested) && (isRecord(nested.orderBy) || Array.isArray(nested.orderBy))
        ? nested.orderBy as OrderSpec | OrderSpec[]
        : undefined
      copy[key] = [...(row[key] as Row[])].sort(compareRows(orderBy))
    }
    return copy
  }

  function queryRows(rows: Row[], args: QueryArgs = {}): Row[] {
    const matched = rows.filter((row) => matches(row, args.where))
    const sorted = [...matched].sort(compareRows(args.orderBy))
    const limited = typeof args.take === 'number' ? sorted.slice(0, args.take) : sorted
    return limited.map((row) => withInclude(row, args.include))
  }

  function readSql(query: unknown): { text: string; values: unknown[] } {
    if (isRecord(query)) {
      const sql = query as { sql?: unknown; strings?: unknown; values?: unknown }
      const text = typeof sql.sql === 'string'
        ? sql.sql
        : Array.isArray(sql.strings)
          ? sql.strings.filter((part): part is string => typeof part === 'string').join('?')
          : ''
      const values = Array.isArray(sql.values) ? sql.values : []
      return { text, values }
    }
    return { text: '', values: [] }
  }

  function legacyLocationRows(rows: Row[], values: unknown[], text: string, ownerField: string): Row[] {
    const ownerId = values[0]
    const assetKind = values[1]
    const folderFiltered = text.includes('AND folderId')
    const folderId = folderFiltered ? values[2] : undefined
    return rows
      .filter((row) => row[ownerField] === ownerId && row.assetKind === assetKind && (!folderFiltered || row.folderId === folderId))
      .sort(compareRows({ createdAt: 'asc' }))
      .map((row) => ({
        id: row.id,
        userId: row.userId,
        folderId: row.folderId,
        novelPromotionProjectId: row.novelPromotionProjectId,
        name: row.name,
        summary: row.summary ?? null,
        artStyle: row.artStyle ?? null,
        assetKind: row.assetKind,
        selectedImageId: row.selectedImageId ?? null,
        sourceGlobalLocationId: row.sourceGlobalLocationId ?? null,
      }))
  }

  const prismaMock = {
    globalCharacter: {
      findMany: vi.fn(async (args: QueryArgs) => queryRows(state.characters, args)),
      count: vi.fn(async (args: QueryArgs) => queryRows(state.characters, args).length),
    },
    globalLocation: {
      findMany: vi.fn(async (args: QueryArgs) => queryRows(state.locations, args)),
      count: vi.fn(async (args: QueryArgs) => queryRows(state.locations, args).length),
    },
    globalVoice: {
      findMany: vi.fn(async (args: QueryArgs) => queryRows(state.voices, args)),
      count: vi.fn(async (args: QueryArgs) => queryRows(state.voices, args).length),
    },
    customArtStyle: {
      findMany: vi.fn(async (args: QueryArgs) => queryRows(state.styles, args)),
      count: vi.fn(async (args: QueryArgs) => queryRows(state.styles, args).length),
      create: vi.fn(),
      updateMany: vi.fn(),
      findFirstOrThrow: vi.fn(),
      deleteMany: vi.fn(),
    },
    novelPromotionCharacter: {
      findMany: vi.fn(async (args: QueryArgs) => queryRows(state.projectCharacters, args)),
      count: vi.fn(async (args: QueryArgs) => queryRows(state.projectCharacters, args).length),
    },
    novelPromotionLocation: {
      findMany: vi.fn(async (args: QueryArgs) => queryRows(state.projectLocations, args)),
      count: vi.fn(async (args: QueryArgs) => queryRows(state.projectLocations, args).length),
    },
    novelPromotionProject: {
      findUnique: vi.fn(async (args: { where?: { projectId?: string }; select?: { characters?: { include?: Row; orderBy?: OrderSpec } } }) => {
        const project = state.projects.find((item) => item.projectId === args.where?.projectId)
        if (!project) return null
        if (args.select?.characters) {
          return {
            id: project.id,
            characters: queryRows(
              state.projectCharacters.filter((item) => item.novelPromotionProjectId === project.id),
              { orderBy: args.select.characters.orderBy, include: args.select.characters.include },
            ),
          }
        }
        return { id: project.id }
      }),
    },
    $queryRaw: vi.fn(async (query: unknown) => {
      const { text, values } = readSql(query)
      state.sql.push(text)
      if (text.includes('global_location_images') || text.includes('FROM location_images')) return []
      if (text.includes('FROM global_locations')) return legacyLocationRows(state.locations, values, text, 'userId')
      if (text.includes('novel_promotion_locations')) return legacyLocationRows(state.projectLocations, values, text, 'novelPromotionProjectId')
      return []
    }),
  }

  return { state, prismaMock }
})

vi.mock('@/lib/api-auth', () => ({
  requireUserAuth: vi.fn(async () => ({ session: { user: { id: state.userId } } })),
  requireProjectAuthLight: vi.fn(async (projectId: string) => ({
    session: { user: { id: state.userId } },
    project: { id: projectId },
  })),
  isErrorResponse: (value: unknown) => value instanceof Response,
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

function at(index: number): Date {
  return new Date(Date.UTC(2024, 0, 1, 0, 0, 0) + index * 1000)
}

function character(fields: { id: string; createdAt: Date; name?: string; userId?: string; folderId?: string | null }): Row {
  return {
    id: fields.id,
    userId: fields.userId ?? 'user-1',
    folderId: fields.folderId ?? null,
    name: fields.name ?? fields.id,
    aliases: null,
    profileData: null,
    profileConfirmed: false,
    voiceId: null,
    voiceType: null,
    customVoiceUrl: null,
    customVoiceMediaId: null,
    globalVoiceId: null,
    createdAt: fields.createdAt,
    updatedAt: fields.createdAt,
    appearances: [],
  }
}

function location(fields: {
  id: string
  createdAt: Date
  name?: string
  userId?: string
  folderId?: string | null
  assetKind?: 'location' | 'prop'
  novelPromotionProjectId?: string
}): Row {
  return {
    id: fields.id,
    userId: fields.userId ?? 'user-1',
    folderId: fields.folderId ?? null,
    novelPromotionProjectId: fields.novelPromotionProjectId,
    name: fields.name ?? fields.id,
    artStyle: null,
    summary: null,
    assetKind: fields.assetKind ?? 'location',
    createdAt: fields.createdAt,
    updatedAt: fields.createdAt,
    selectedImageId: null,
    sourceGlobalLocationId: null,
    images: [],
  }
}

function voice(fields: { id: string; createdAt: Date; name?: string; userId?: string; folderId?: string | null }): Row {
  return {
    id: fields.id,
    userId: fields.userId ?? 'user-1',
    folderId: fields.folderId ?? null,
    name: fields.name ?? fields.id,
    description: null,
    voiceId: null,
    voiceType: 'qwen-designed',
    customVoiceUrl: null,
    customVoiceMediaId: null,
    voicePrompt: null,
    gender: null,
    language: 'zh',
    createdAt: fields.createdAt,
    updatedAt: fields.createdAt,
  }
}

function style(fields: { id: string; name: string; createdAt: Date; updatedAt?: Date; userId?: string }): Row {
  return {
    id: fields.id,
    userId: fields.userId ?? 'user-1',
    name: fields.name,
    prompt: 'prompt',
    createdAt: fields.createdAt,
    updatedAt: fields.updatedAt ?? fields.createdAt,
  }
}

function projectCharacter(fields: { id: string; createdAt: Date; name?: string; novelPromotionProjectId?: string }): Row {
  return {
    id: fields.id,
    novelPromotionProjectId: fields.novelPromotionProjectId ?? 'np-1',
    name: fields.name ?? fields.id,
    aliases: null,
    createdAt: fields.createdAt,
    updatedAt: fields.createdAt,
    customVoiceUrl: null,
    customVoiceMediaId: null,
    voiceId: null,
    voiceType: null,
    profileData: null,
    profileConfirmed: false,
    introduction: null,
    sourceGlobalCharacterId: null,
    appearances: [],
  }
}

type AssetBody = {
  assets: Array<{ id: string; name: string; kind: string }>
  nextCursor: string | null
  total?: number
}

type StyleBody = {
  styles: Array<{ id: string; name: string; value: string }>
  nextCursor: string | null
  total?: number
}

type ErrorBody = {
  error: { code: string; message: string }
}

async function assetsGet(query: string): Promise<{ status: number; text: string; body: AssetBody & ErrorBody }> {
  const response = await getAssets(buildMockRequest({ path: `/api/assets?${query}`, method: 'GET' }), { params: Promise.resolve({}) })
  const text = await response.text()
  return { status: response.status, text, body: JSON.parse(text) as AssetBody & ErrorBody }
}

async function stylesGet(query = ''): Promise<{ status: number; text: string; body: StyleBody & ErrorBody }> {
  const path = query ? `/api/asset-hub/styles?${query}` : '/api/asset-hub/styles'
  const response = await getStyles(buildMockRequest({ path, method: 'GET' }), { params: Promise.resolve({}) })
  const text = await response.text()
  return { status: response.status, text, body: JSON.parse(text) as StyleBody & ErrorBody }
}

async function expectedGlobalCharacter(row: Row) {
  const withMedia = await attachMediaFieldsToGlobalCharacter(row)
  return mapGlobalCharacterToAsset(withMedia as unknown as Parameters<typeof mapGlobalCharacterToAsset>[0])
}

async function expectedGlobalLocation(row: Row, kind: 'location' | 'prop') {
  const withMedia = await attachMediaFieldsToGlobalLocation({
    id: row.id,
    userId: row.userId,
    folderId: row.folderId,
    name: row.name,
    summary: row.summary ?? null,
    artStyle: row.artStyle ?? null,
    assetKind: row.assetKind,
    images: [],
  })
  return kind === 'location'
    ? mapGlobalLocationToAsset(withMedia as unknown as Parameters<typeof mapGlobalLocationToAsset>[0])
    : mapGlobalPropToAsset(withMedia as unknown as Parameters<typeof mapGlobalPropToAsset>[0])
}

async function expectedGlobalVoice(row: Row) {
  const withMedia = await attachMediaFieldsToGlobalVoice(row)
  return mapGlobalVoiceToAsset(withMedia as unknown as Parameters<typeof mapGlobalVoiceToAsset>[0])
}

async function expectedProjectCharacter(row: Row) {
  const withMedia = await attachMediaFieldsToProject({ characters: [row] })
  const character = withMedia.characters?.[0]
  if (!character) throw new Error('missing project character')
  return mapProjectCharacterToAsset(character as unknown as Parameters<typeof mapProjectCharacterToAsset>[0])
}

async function expectedProjectLocation(row: Row, kind: 'location' | 'prop') {
  const record = { ...row, images: [] }
  const withMedia = kind === 'location'
    ? await attachMediaFieldsToProject({ locations: [record] })
    : await attachMediaFieldsToProject({ props: [record] })
  const mapped = kind === 'location' ? withMedia.locations?.[0] : withMedia.props?.[0]
  if (!mapped) throw new Error('missing project location')
  return kind === 'location'
    ? mapProjectLocationToAsset(mapped as unknown as Parameters<typeof mapProjectLocationToAsset>[0])
    : mapProjectPropToAsset(mapped as unknown as Parameters<typeof mapProjectPropToAsset>[0])
}

function clearStore() {
  state.userId = 'user-1'
  state.characters.length = 0
  state.locations.length = 0
  state.voices.length = 0
  state.styles.length = 0
  state.projects.length = 0
  state.projectCharacters.length = 0
  state.projectLocations.length = 0
  state.sql.length = 0
}

describe('api contract - asset list cursor pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearStore()
  })

  it('returns an empty global list', async () => {
    const legacy = await assetsGet('scope=global')
    expect(legacy.status).toBe(200)
    expect(legacy.text).toBe(JSON.stringify({ assets: [] }))

    const paged = await assetsGet('scope=global&limit=24')
    expect(paged.status).toBe(200)
    expect(paged.body).toEqual({ assets: [], nextCursor: null, total: 0 })
    expect(paged.text).toBe(JSON.stringify({ assets: [], nextCursor: null, total: 0 }))
  })

  it('walks every global page until the union equals the full dataset', async () => {
    state.characters.push(
      character({ id: 'c3', name: 'C3', createdAt: at(5) }),
      character({ id: 'c2', name: 'C2', createdAt: at(4) }),
    )
    state.locations.push(
      location({ id: 'loc', name: 'Loc', createdAt: at(3) }),
      location({ id: 'prop', name: 'Prop', createdAt: at(2), assetKind: 'prop' }),
    )
    state.voices.push(voice({ id: 'voice', name: 'Voice', createdAt: at(1) }))
    const expected = ['c3', 'c2', 'loc', 'prop', 'voice']

    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    while (pages < 10) {
      const query = cursor
        ? `scope=global&limit=2&cursor=${encodeURIComponent(cursor)}`
        : 'scope=global&limit=2'
      const response = await assetsGet(query)
      expect(response.status).toBe(200)
      seen.push(...response.body.assets.map((asset) => asset.id))
      pages += 1
      if (!response.body.nextCursor) break
      cursor = response.body.nextCursor
    }

    expect(pages).toBe(3)
    expect(seen).toEqual(expected)
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('keeps GET /api/assets byte-for-byte compatible when cursor and limit are absent', async () => {
    const olderCharacter = character({ id: 'char-old', name: 'Old', createdAt: at(30) })
    const newerCharacter = character({ id: 'char-new', name: 'New', createdAt: at(10) })
    const olderLocation = location({ id: 'loc-old', name: 'Hall', createdAt: at(5) })
    const newerProp = location({ id: 'prop-new', name: 'Blade', createdAt: at(40), assetKind: 'prop' })
    const newerVoice = voice({ id: 'voice-new', name: 'Narrator', createdAt: at(50) })
    state.characters.push(newerCharacter, olderCharacter)
    state.locations.push(olderLocation, newerProp)
    state.voices.push(newerVoice)

    const legacy = await assetsGet('scope=global&q=Hall')
    const again = await assetsGet('scope=global')
    const expected = {
      assets: [
        await expectedGlobalCharacter(newerCharacter),
        await expectedGlobalCharacter(olderCharacter),
        await expectedGlobalLocation(olderLocation, 'location'),
        await expectedGlobalLocation(newerProp, 'prop'),
        await expectedGlobalVoice(newerVoice),
      ],
    }

    expect(legacy.status).toBe(200)
    expect(legacy.text).toBe(JSON.stringify(expected))
    expect(again.text).toBe(legacy.text)
    expect(legacy.text).not.toContain('nextCursor')
    expect(legacy.text).not.toContain('"total"')
    expect(prismaMock.globalCharacter.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user-1' },
      orderBy: { createdAt: 'asc' },
    }))
  })

  it('pages global assets by createdAt desc, id desc and omits total after the first page', async () => {
    const sameTime = at(20)
    state.characters.push(
      character({ id: 'id-a', name: 'A', createdAt: sameTime }),
      character({ id: 'id-b', name: 'B', createdAt: sameTime }),
      character({ id: 'older', name: 'Older', createdAt: at(10) }),
    )
    state.locations.push(location({ id: 'loc-mid', name: 'Mid', createdAt: at(15) }))

    const first = await assetsGet('scope=global&limit=1')
    expect(first.status).toBe(200)
    expect(Object.keys(first.body)).toEqual(['assets', 'nextCursor', 'total'])
    expect(first.body.total).toBe(4)
    expect(first.body.assets.map((asset) => asset.id)).toEqual(['id-b'])
    expect(first.body.nextCursor).toEqual(expect.any(String))
    expect(first.text).toBe(JSON.stringify({
      assets: [await expectedGlobalCharacter(character({ id: 'id-b', name: 'B', createdAt: sameTime }))],
      nextCursor: first.body.nextCursor,
      total: 4,
    }))

    const second = await assetsGet(`scope=global&limit=1&cursor=${encodeURIComponent(first.body.nextCursor ?? '')}`)
    expect(Object.keys(second.body)).toEqual(['assets', 'nextCursor'])
    expect(second.body.assets.map((asset) => asset.id)).toEqual(['id-a'])
    expect(second.text).not.toContain('"total"')

    const third = await assetsGet(`scope=global&limit=1&cursor=${encodeURIComponent(second.body.nextCursor ?? '')}`)
    expect(third.body.assets.map((asset) => asset.id)).toEqual(['loc-mid'])

    prismaMock.globalCharacter.count.mockClear()
    const fourth = await assetsGet(`scope=global&limit=10&cursor=${encodeURIComponent(third.body.nextCursor ?? '')}`)
    expect(fourth.body.assets.map((asset) => asset.id)).toEqual(['older'])
    expect(fourth.body.nextCursor).toBeNull()
    expect(fourth.body).not.toHaveProperty('total')
    expect(prismaMock.globalCharacter.count).not.toHaveBeenCalled()
  })

  it('uses the default limit of 24 when a later page sends only a cursor', async () => {
    for (let index = 1; index <= 30; index += 1) {
      state.characters.push(character({ id: `c-${String(index).padStart(2, '0')}`, createdAt: at(index) }))
    }
    const first = await assetsGet('scope=global&kind=character&limit=1')
    const second = await assetsGet(`scope=global&kind=character&cursor=${encodeURIComponent(first.body.nextCursor ?? '')}`)
    expect(second.body.assets).toHaveLength(24)
    expect(second.body.nextCursor).toEqual(expect.any(String))
    expect(second.body.assets[0]?.id).toBe('c-29')
    expect(second.body.assets[23]?.id).toBe('c-06')
  })

  it('returns the last page without a trailing empty page when the count divides evenly', async () => {
    for (let index = 1; index <= 4; index += 1) {
      state.voices.push(voice({ id: `v-${index}`, createdAt: at(index) }))
    }
    const first = await assetsGet('scope=global&kind=voice&limit=2')
    const second = await assetsGet(`scope=global&kind=voice&limit=2&cursor=${encodeURIComponent(first.body.nextCursor ?? '')}`)
    expect(first.body.assets.map((asset) => asset.id)).toEqual(['v-4', 'v-3'])
    expect(first.body.total).toBe(4)
    expect(second.body.assets.map((asset) => asset.id)).toEqual(['v-2', 'v-1'])
    expect(second.body.nextCursor).toBeNull()
    expect(second.body).not.toHaveProperty('total')

    state.voices.length = 0
    for (let index = 1; index <= 100; index += 1) {
      state.voices.push(voice({ id: `m-${String(index).padStart(3, '0')}`, createdAt: at(index) }))
    }
    const full = await assetsGet('scope=global&kind=voice&limit=100')
    expect(full.status).toBe(200)
    expect(full.body.assets).toHaveLength(100)
    expect(full.body.nextCursor).toBeNull()
    expect(full.body.total).toBe(100)

    state.voices.push(voice({ id: 'm-101', createdAt: at(101) }))
    const overflow = await assetsGet('scope=global&kind=voice&limit=100')
    expect(overflow.body.assets).toHaveLength(100)
    expect(overflow.body.total).toBe(101)
    expect(overflow.body.assets[0]?.id).toBe('m-101')
    const remainder = await assetsGet(`scope=global&kind=voice&limit=100&cursor=${encodeURIComponent(overflow.body.nextCursor ?? '')}`)
    expect(remainder.body.assets.map((asset) => asset.id)).toEqual(['m-001'])
    expect(remainder.body.nextCursor).toBeNull()
    expect(remainder.body).not.toHaveProperty('total')
  })

  it('rejects invalid limits and malformed, forged, or mismatched cursors with 400', async () => {
    state.characters.push(
      character({ id: 'keep', name: 'Alpha', createdAt: at(2), folderId: 'folder-a' }),
      character({ id: 'next', name: 'Alpha two', createdAt: at(1), folderId: 'folder-a' }),
    )
    const limits = ['0', '-1', '101', 'abc', '1.5', '1e1', '+10', '00', '']
    for (const limit of limits) {
      const response = await assetsGet(`scope=global&limit=${encodeURIComponent(limit)}`)
      expect(response.status, `limit ${limit}`).toBe(400)
      expect(response.body.error.code).toBe('INVALID_PARAMS')
      expect(response.body.error.message).toBe('limit must be an integer between 1 and 100')
    }
    const longQuery = await assetsGet(`scope=global&limit=1&q=${'a'.repeat(201)}`)
    expect(longQuery.status).toBe(400)
    expect(longQuery.body.error.message).toBe('q must be at most 200 characters')
    const styleLimit = await stylesGet('limit=101')
    expect(styleLimit.status).toBe(400)
    expect(styleLimit.body.error.message).toBe('limit must be an integer between 1 and 100')
    expect(prismaMock.globalCharacter.findMany).not.toHaveBeenCalled()

    const first = await assetsGet('scope=global&kind=character&folderId=folder-a&limit=1')
    const cursor = first.body.nextCursor ?? ''
    const forgedJson = Buffer.from(JSON.stringify({
      v: 1,
      t: at(2).toISOString(),
      id: 'keep',
      fh: 'forged',
      sig: 'not-a-signature',
    }), 'utf8').toString('base64url')
    const tampered = `${cursor.slice(0, -4)}AAAA`
    for (const bad of ['not-a-cursor', '', 'null', forgedJson, tampered]) {
      const response = await assetsGet(`scope=global&kind=character&folderId=folder-a&limit=1&cursor=${encodeURIComponent(bad)}`)
      expect(response.status, bad).toBe(400)
      expect(response.body.error.code).toBe('INVALID_PARAMS')
      expect(response.body.error.message).toBe('Invalid cursor')
    }

    const mismatches = [
      'scope=global&kind=location&folderId=folder-a&limit=1',
      'scope=global&kind=character&folderId=folder-b&limit=1',
      'scope=global&kind=character&folderId=folder-a&q=other&limit=1',
      'scope=global&kind=character&folderId=folder-a&projectId=project-9&limit=1',
      'scope=project&projectId=project-1&kind=character&folderId=folder-a&limit=1',
    ]
    for (const query of mismatches) {
      const response = await assetsGet(`${query}&cursor=${encodeURIComponent(cursor)}`)
      expect(response.status, query).toBe(400)
      expect(response.body.error.message).toBe('Cursor does not match the current filters')
    }

    state.styles.push(
      style({ id: 'style-1', name: 'One', createdAt: at(2) }),
      style({ id: 'style-2', name: 'Two', createdAt: at(1) }),
    )
    const styleCursor = await stylesGet('limit=1')
    expect(styleCursor.body.nextCursor).toEqual(expect.any(String))
    const reused = await assetsGet(`scope=global&limit=1&cursor=${encodeURIComponent(styleCursor.body.nextCursor ?? '')}`)
    expect(reused.status).toBe(400)
    expect(reused.body.error.code).toBe('INVALID_PARAMS')
  })

  it('filters by name, folder, and kind without leaking another user through folderId or cursor', async () => {
    state.characters.push(
      character({ id: 'alpha', name: 'Alpha', createdAt: at(3), folderId: 'folder-a' }),
      character({ id: 'alpine', name: 'alpine', createdAt: at(4), folderId: 'folder-a' }),
      character({ id: 'beta', name: 'Beta', createdAt: at(5), folderId: 'folder-b' }),
      character({ id: 'secret', name: 'Alpha secret', createdAt: at(9), folderId: 'folder-a', userId: 'user-2' }),
      character({ id: 'literal', name: '100%_ready', createdAt: at(6), folderId: 'folder-a' }),
      character({ id: 'wildcard', name: '100ABready', createdAt: at(7), folderId: 'folder-a' }),
    )
    state.locations.push(location({ id: 'hall', name: 'Alpha hall', createdAt: at(8), folderId: 'folder-a', assetKind: 'location' }))
    state.locations.push(location({ id: 'dagger', name: 'Alpha dagger', createdAt: at(2), folderId: 'folder-a', assetKind: 'prop' }))

    const searched = await assetsGet('scope=global&folderId=folder-a&q=alp&limit=10')
    expect(searched.body.total).toBe(4)
    expect(searched.body.nextCursor).toBeNull()
    expect(searched.body.assets.map((asset) => asset.id)).toEqual(['hall', 'alpine', 'alpha', 'dagger'])
    expect(searched.body.assets.map((asset) => asset.kind)).toEqual(['location', 'character', 'character', 'prop'])

    const props = await assetsGet('scope=global&kind=prop&q=alpha&limit=10')
    expect(props.body.assets.map((asset) => asset.id)).toEqual(['dagger'])

    const literal = await assetsGet(`scope=global&kind=character&q=${encodeURIComponent('100%_ready')}&limit=10`)
    expect(literal.body.assets.map((asset) => asset.id)).toEqual(['literal'])

    const ownerPage = await assetsGet('scope=global&folderId=folder-a&kind=character&limit=1')
    const ownerNext = await assetsGet(`scope=global&folderId=folder-a&kind=character&limit=10&cursor=${encodeURIComponent(ownerPage.body.nextCursor ?? '')}`)
    expect(ownerNext.status).toBe(200)
    expect(prismaMock.globalCharacter.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        userId: 'user-1',
        folderId: 'folder-a',
        OR: expect.any(Array),
      }),
      take: 11,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }))

    vi.clearAllMocks()
    state.userId = 'user-2'
    state.characters.push(character({ id: 'mine', name: 'Mine', createdAt: at(1), folderId: 'folder-a', userId: 'user-2' }))
    const foreignFolder = await assetsGet('scope=global&folderId=folder-a&limit=24')
    expect(foreignFolder.body.assets.map((asset) => asset.id)).toEqual(['secret', 'mine'])
    expect(foreignFolder.body.total).toBe(2)
    for (const call of prismaMock.globalCharacter.findMany.mock.calls) {
      expect(call[0]?.where).toEqual(expect.objectContaining({ userId: 'user-2' }))
    }

    prismaMock.globalCharacter.findMany.mockClear()
    const foreignCursor = await assetsGet(`scope=global&folderId=folder-a&kind=character&limit=10&cursor=${encodeURIComponent(ownerPage.body.nextCursor ?? '')}`)
    expect(foreignCursor.status).toBe(400)
    expect(foreignCursor.body.error.code).toBe('INVALID_PARAMS')
    expect(foreignCursor.body.error.message).toBe('Cursor does not match the current filters')
    expect(prismaMock.globalCharacter.findMany).not.toHaveBeenCalled()
  })

  it('stays on the keyset when rows are created, edited, or deleted during pagination', async () => {
    const rows = [5, 4, 3, 2, 1].map((index) => character({
      id: `c${index}`,
      name: `Name ${index}`,
      createdAt: at(index),
    }))
    state.characters.push(...rows)

    const first = await assetsGet('scope=global&kind=character&limit=2')
    expect(first.body.assets.map((asset) => asset.id)).toEqual(['c5', 'c4'])
    const cursor = first.body.nextCursor ?? ''

    const cursorRow = state.characters.find((row) => row.id === 'c4')
    const removed = state.characters.findIndex((row) => row.id === 'c4')
    state.characters.splice(removed, 1)
    const skipped = state.characters.findIndex((row) => row.id === 'c3')
    state.characters.splice(skipped, 1)
    const renamed = state.characters.find((row) => row.id === 'c2')
    if (!renamed || !cursorRow) throw new Error('fixture missing')
    renamed.name = 'Renamed'
    state.characters.push(character({ id: 'c6', name: 'Newest', createdAt: at(9) }))

    const second = await assetsGet(`scope=global&kind=character&limit=2&cursor=${encodeURIComponent(cursor)}`)
    expect(second.status).toBe(200)
    expect(second.body.assets.map((asset) => asset.id)).toEqual(['c2', 'c1'])
    expect(second.body.assets.map((asset) => asset.name)).toEqual(['Renamed', 'Name 1'])
    expect(second.body.nextCursor).toBeNull()
    expect(second.body.assets.some((asset) => asset.id === 'c6' || asset.id === 'c3' || asset.id === cursorRow.id)).toBe(false)

    const fresh = await assetsGet('scope=global&kind=character&limit=10')
    expect(fresh.body.assets.map((asset) => asset.id)).toEqual(['c6', 'c5', 'c2', 'c1'])
    expect(fresh.body.total).toBe(4)
    expect(fresh.body.assets[2]?.name).toBe('Renamed')
  })

  it('paginates project assets without changing the unpaged project payload', async () => {
    state.projects.push({ id: 'np-1', projectId: 'project-1' })
    const olderLocation = location({
      id: 'room',
      name: 'Room',
      createdAt: at(1),
      novelPromotionProjectId: 'np-1',
      assetKind: 'location',
    })
    const newerCharacter = projectCharacter({ id: 'hero', name: 'Hero', createdAt: at(3) })
    const olderProp = location({
      id: 'cup',
      name: 'Cup',
      createdAt: at(2),
      novelPromotionProjectId: 'np-1',
      assetKind: 'prop',
    })
    state.projectCharacters.push(newerCharacter)
    state.projectLocations.push(olderLocation, olderProp)

    const legacy = await assetsGet('scope=project&projectId=project-1&q=Hero')
    expect(legacy.text).toBe(JSON.stringify({
      assets: [
        await expectedProjectCharacter(newerCharacter),
        await expectedProjectLocation(olderLocation, 'location'),
        await expectedProjectLocation(olderProp, 'prop'),
      ],
    }))

    const paged = await assetsGet('scope=project&projectId=project-1&limit=2')
    expect(paged.body.total).toBe(3)
    expect(paged.body.assets.map((asset) => asset.id)).toEqual(['hero', 'cup'])
    const next = await assetsGet(`scope=project&projectId=project-1&limit=2&cursor=${encodeURIComponent(paged.body.nextCursor ?? '')}`)
    expect(next.body.assets.map((asset) => asset.id)).toEqual(['room'])
    expect(next.body.nextCursor).toBeNull()

    state.userId = 'user-2'
    const otherUser = await assetsGet(`scope=project&projectId=project-1&limit=2&cursor=${encodeURIComponent(paged.body.nextCursor ?? '')}`)
    expect(otherUser.status).toBe(400)
    expect(otherUser.body.error.message).toBe('Cursor does not match the current filters')
    state.userId = 'user-1'

    const otherProject = await assetsGet(`scope=project&projectId=project-2&limit=2&cursor=${encodeURIComponent(paged.body.nextCursor ?? '')}`)
    expect(otherProject.status).toBe(400)
    expect(otherProject.body.error.message).toBe('Cursor does not match the current filters')

    const voices = await assetsGet('scope=project&projectId=project-1&kind=voice&limit=10')
    expect(voices.body).toEqual({ assets: [], nextCursor: null, total: 0 })
  })

  it('keeps GET /api/asset-hub/styles compatible and pages styles by createdAt desc, id desc', async () => {
    const editedLater = style({ id: 'style-a', name: 'Ink', createdAt: at(1), updatedAt: at(9) })
    const createdLater = style({ id: 'style-b', name: 'Ink wash', createdAt: at(5), updatedAt: at(2) })
    const tied = style({ id: 'style-c', name: 'Ink tie', createdAt: at(5), updatedAt: at(1) })
    state.styles.push(editedLater, createdLater, tied)

    const legacy = await stylesGet('q=nope')
    const again = await stylesGet()
    const expected = {
      styles: [editedLater, createdLater, tied].map((item) => ({ ...item, value: `custom:${String(item.id)}` })),
    }
    expect(legacy.status).toBe(200)
    expect(legacy.text).toBe(JSON.stringify(expected))
    expect(again.text).toBe(legacy.text)
    expect(prismaMock.customArtStyle.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      orderBy: { updatedAt: 'desc' },
    })

    const first = await stylesGet('limit=1&q=ink')
    expect(first.body.total).toBe(3)
    expect(first.body.styles.map((item) => item.id)).toEqual(['style-c'])
    expect(first.body.styles[0]?.value).toBe('custom:style-c')
    expect(Object.keys(first.body)).toEqual(['styles', 'nextCursor', 'total'])

    const mismatched = await stylesGet(`q=wash&cursor=${encodeURIComponent(first.body.nextCursor ?? '')}`)
    expect(mismatched.status).toBe(400)
    expect(mismatched.body.error.message).toBe('Cursor does not match the current filters')

    const removed = state.styles.findIndex((item) => item.id === 'style-c')
    state.styles.splice(removed, 1)
    state.styles.push(style({ id: 'style-d', name: 'Ink mine', createdAt: at(3), userId: 'user-2' }))
    const second = await stylesGet(`q=ink&cursor=${encodeURIComponent(first.body.nextCursor ?? '')}`)
    expect(second.status).toBe(200)
    expect(second.body.styles.map((item) => item.id)).toEqual(['style-b', 'style-a'])
    expect(second.body.nextCursor).toBeNull()
    expect(second.body).not.toHaveProperty('total')

    state.userId = 'user-2'
    const isolated = await stylesGet('limit=10')
    expect(isolated.body.styles.map((item) => item.id)).toEqual(['style-d'])
    const replay = await stylesGet(`q=ink&limit=10&cursor=${encodeURIComponent(first.body.nextCursor ?? '')}`)
    expect(replay.status).toBe(400)
    expect(replay.body.error.message).toBe('Cursor does not match the current filters')
  })
})
