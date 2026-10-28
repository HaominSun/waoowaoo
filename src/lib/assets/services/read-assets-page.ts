import { prisma } from '@/lib/prisma'
import { ApiError } from '@/lib/api-errors'
import type { AssetKind, AssetSummary } from '@/lib/assets/contracts'
import {
  mapGlobalCharacterToAsset,
  mapGlobalLocationToAsset,
  mapGlobalPropToAsset,
  mapGlobalVoiceToAsset,
  mapProjectCharacterToAsset,
  mapProjectLocationToAsset,
  mapProjectPropToAsset,
} from '@/lib/assets/mappers'
import {
  attachMediaFieldsToGlobalCharacter,
  attachMediaFieldsToGlobalLocation,
  attachMediaFieldsToGlobalVoice,
  attachMediaFieldsToProject,
} from '@/lib/media/attach'
import { logError as _ulogError } from '@/lib/logging/core'
import {
  KEYSET_ORDER_BY,
  keysetWhere,
  mergeKeysetRows,
  nameContains,
  type EnabledListPage,
} from '@/lib/pagination/keyset-cursor'

export type AssetListPage = {
  assets: AssetSummary[]
  nextCursor: string | null
  total?: number
}

type RankedAsset = {
  createdAt: Date
  id: string
  value: AssetSummary
}

const GLOBAL_KINDS = ['character', 'location', 'prop', 'voice'] as const
const PROJECT_KINDS = ['character', 'location', 'prop'] as const

function asAssetKind(kind: string | null): AssetKind | null {
  if (kind === 'character' || kind === 'location' || kind === 'prop' || kind === 'voice') return kind
  return null
}

function kindsFor(scope: 'global' | 'project', kind: AssetKind | null): AssetKind[] {
  const available: readonly AssetKind[] = scope === 'global' ? GLOBAL_KINDS : PROJECT_KINDS
  if (!kind) return [...available]
  return available.includes(kind) ? [kind] : []
}

function assertUserId(userId: string | null | undefined): string {
  if (!userId) {
    throw new Error('userId is required for global asset scope')
  }
  return userId
}

function emptyPage(page: EnabledListPage, total: number): AssetListPage {
  return page.cursor
    ? { assets: [], nextCursor: null }
    : { assets: [], nextCursor: null, total }
}

function finishPage(page: EnabledListPage, groups: RankedAsset[][], total: number | undefined): AssetListPage {
  const merged = mergeKeysetRows(groups, page.limit, page.filters)
  const body: AssetListPage = {
    assets: merged.items,
    nextCursor: merged.nextCursor,
  }
  if (total !== undefined) body.total = total
  return body
}

function nameFilter(q: string | null): { name: { contains: string } } | undefined {
  const contains = nameContains(q)
  if (!contains) return undefined
  return { name: contains }
}

type DatedRow = { id: string; createdAt: Date }

async function mapGlobalCharacters(rows: readonly DatedRow[]): Promise<RankedAsset[]> {
  return Promise.all(rows.map(async (character) => {
    const record = character as DatedRow & Record<string, unknown>
    try {
      const withMedia = await attachMediaFieldsToGlobalCharacter(record)
      return {
        createdAt: character.createdAt,
        id: character.id,
        value: mapGlobalCharacterToAsset(withMedia as unknown as Parameters<typeof mapGlobalCharacterToAsset>[0]),
      }
    } catch (error) {
      _ulogError('[assets] skipping malformed global character media fields', {
        characterId: character.id,
        error: error instanceof Error ? error.message : String(error),
      })
      return {
        createdAt: character.createdAt,
        id: character.id,
        value: mapGlobalCharacterToAsset({
          ...record,
          appearances: [],
        } as unknown as Parameters<typeof mapGlobalCharacterToAsset>[0]),
      }
    }
  }))
}

async function mapGlobalLocations(kind: 'location' | 'prop', rows: readonly DatedRow[]): Promise<RankedAsset[]> {
  const withMedia = await Promise.all(rows.map((row) => (
    attachMediaFieldsToGlobalLocation(row as DatedRow & Record<string, unknown>)
  )))
  return withMedia.map((row) => ({
    createdAt: row.createdAt as Date,
    id: String(row.id),
    value: kind === 'location'
      ? mapGlobalLocationToAsset(row as unknown as Parameters<typeof mapGlobalLocationToAsset>[0])
      : mapGlobalPropToAsset(row as unknown as Parameters<typeof mapGlobalPropToAsset>[0]),
  }))
}

async function mapGlobalVoices(rows: readonly DatedRow[]): Promise<RankedAsset[]> {
  const withMedia = await Promise.all(rows.map((row) => (
    attachMediaFieldsToGlobalVoice(row as DatedRow & Record<string, unknown>)
  )))
  return withMedia.map((row) => ({
    createdAt: row.createdAt as Date,
    id: String(row.id),
    value: mapGlobalVoiceToAsset(row as unknown as Parameters<typeof mapGlobalVoiceToAsset>[0]),
  }))
}

function globalWhere(userId: string, page: EnabledListPage, assetKind?: 'location' | 'prop') {
  return {
    userId,
    ...(assetKind ? { assetKind } : {}),
    ...(page.filters.folderId ? { folderId: page.filters.folderId } : {}),
    ...nameFilter(page.filters.q),
    ...keysetWhere(page.cursor),
  }
}

async function loadGlobalKind(userId: string, kind: AssetKind, page: EnabledListPage): Promise<RankedAsset[]> {
  const take = page.limit + 1
  const orderBy = [...KEYSET_ORDER_BY]
  if (kind === 'character') {
    const rows = await prisma.globalCharacter.findMany({
      where: globalWhere(userId, page),
      include: { appearances: { orderBy: { appearanceIndex: 'asc' } } },
      orderBy,
      take,
    })
    return mapGlobalCharacters(rows)
  }
  if (kind === 'voice') {
    const rows = await prisma.globalVoice.findMany({
      where: globalWhere(userId, page),
      orderBy,
      take,
    })
    return mapGlobalVoices(rows)
  }
  const rows = await prisma.globalLocation.findMany({
    where: globalWhere(userId, page, kind),
    include: { images: { orderBy: { imageIndex: 'asc' } } },
    orderBy,
    take,
  })
  return mapGlobalLocations(kind, rows)
}

async function countGlobalKind(userId: string, kind: AssetKind, page: EnabledListPage): Promise<number> {
  if (kind === 'character') {
    return prisma.globalCharacter.count({ where: globalWhere(userId, { ...page, cursor: null }, undefined) })
  }
  if (kind === 'voice') {
    return prisma.globalVoice.count({ where: globalWhere(userId, { ...page, cursor: null }) })
  }
  return prisma.globalLocation.count({ where: globalWhere(userId, { ...page, cursor: null }, kind) })
}

async function readGlobalAssetPage(userId: string, page: EnabledListPage): Promise<AssetListPage> {
  const kinds = kindsFor('global', asAssetKind(page.filters.kind))
  const [groups, total] = await Promise.all([
    Promise.all(kinds.map((kind) => loadGlobalKind(userId, kind, page))),
    page.cursor
      ? Promise.resolve(undefined)
      : Promise.all(kinds.map((kind) => countGlobalKind(userId, kind, page))).then((counts) => (
        counts.reduce((sum, count) => sum + count, 0)
      )),
  ])
  return finishPage(page, groups, total)
}

function projectWhere(novelPromotionProjectId: string, page: EnabledListPage, assetKind?: 'location' | 'prop') {
  return {
    novelPromotionProjectId,
    ...(assetKind ? { assetKind } : {}),
    ...nameFilter(page.filters.q),
    ...keysetWhere(page.cursor),
  }
}

async function mapProjectCharacters(rows: readonly DatedRow[]): Promise<RankedAsset[]> {
  const withMedia = await attachMediaFieldsToProject({
    characters: rows as unknown as Array<Record<string, unknown>>,
  })
  const characters = [...(withMedia.characters ?? [])] as unknown as DatedRow[]
  return characters.map((row) => ({
    createdAt: row.createdAt,
    id: row.id,
    value: mapProjectCharacterToAsset(row as unknown as Parameters<typeof mapProjectCharacterToAsset>[0]),
  }))
}

async function mapProjectLocations(kind: 'location' | 'prop', rows: readonly DatedRow[]): Promise<RankedAsset[]> {
  const source = rows as unknown as Array<Record<string, unknown>>
  const withMedia = kind === 'location'
    ? await attachMediaFieldsToProject({ locations: source })
    : await attachMediaFieldsToProject({ props: source })
  const records = [...(kind === 'location' ? withMedia.locations ?? [] : withMedia.props ?? [])] as unknown as DatedRow[]
  return records.map((row) => ({
    createdAt: row.createdAt,
    id: row.id,
    value: kind === 'location'
      ? mapProjectLocationToAsset(row as unknown as Parameters<typeof mapProjectLocationToAsset>[0])
      : mapProjectPropToAsset(row as unknown as Parameters<typeof mapProjectPropToAsset>[0]),
  }))
}

async function loadProjectKind(
  novelPromotionProjectId: string,
  kind: AssetKind,
  page: EnabledListPage,
): Promise<RankedAsset[]> {
  const take = page.limit + 1
  const orderBy = [...KEYSET_ORDER_BY]
  if (kind === 'character') {
    const rows = await prisma.novelPromotionCharacter.findMany({
      where: projectWhere(novelPromotionProjectId, page),
      include: { appearances: { orderBy: { appearanceIndex: 'asc' } } },
      orderBy,
      take,
    })
    return mapProjectCharacters(rows)
  }
  if (kind === 'voice') return []
  const rows = await prisma.novelPromotionLocation.findMany({
    where: projectWhere(novelPromotionProjectId, page, kind),
    include: { images: { orderBy: { imageIndex: 'asc' } } },
    orderBy,
    take,
  })
  return mapProjectLocations(kind, rows)
}

async function countProjectKind(
  novelPromotionProjectId: string,
  kind: AssetKind,
  page: EnabledListPage,
): Promise<number> {
  const unpaged = { ...page, cursor: null }
  if (kind === 'character') {
    return prisma.novelPromotionCharacter.count({ where: projectWhere(novelPromotionProjectId, unpaged) })
  }
  if (kind === 'voice') return 0
  return prisma.novelPromotionLocation.count({ where: projectWhere(novelPromotionProjectId, unpaged, kind) })
}

async function readProjectAssetPage(projectId: string, page: EnabledListPage): Promise<AssetListPage> {
  const project = await prisma.novelPromotionProject.findUnique({
    where: { projectId },
    select: { id: true },
  })
  if (!project) return emptyPage(page, 0)
  const kinds = kindsFor('project', asAssetKind(page.filters.kind))
  const [groups, total] = await Promise.all([
    Promise.all(kinds.map((kind) => loadProjectKind(project.id, kind, page))),
    page.cursor
      ? Promise.resolve(undefined)
      : Promise.all(kinds.map((kind) => countProjectKind(project.id, kind, page))).then((counts) => (
        counts.reduce((sum, count) => sum + count, 0)
      )),
  ])
  return finishPage(page, groups, total)
}

export async function readAssetPage(
  page: EnabledListPage,
  access?: { userId?: string | null },
): Promise<AssetListPage> {
  if (page.filters.scope === 'project') {
    if (!page.filters.projectId) {
      throw new ApiError('INVALID_PARAMS', { details: 'projectId is required for project scope' })
    }
    return readProjectAssetPage(page.filters.projectId, page)
  }
  if (page.filters.scope !== 'global') {
    throw new ApiError('INVALID_PARAMS', { details: 'scope must be global or project' })
  }
  return readGlobalAssetPage(assertUserId(access?.userId), page)
}
