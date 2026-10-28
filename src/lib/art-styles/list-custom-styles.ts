import { prisma } from '@/lib/prisma'
import { customArtStyleValue } from '@/lib/art-styles/custom'
import {
  KEYSET_ORDER_BY,
  keysetWhere,
  nameContains,
  sliceKeysetRows,
  type EnabledListPage,
} from '@/lib/pagination/keyset-cursor'

export type CustomArtStylePage = {
  styles: Array<{ value: string }>
  nextCursor: string | null
  total?: number
}

function presentStyle<T extends { id: string }>(style: T): T & { value: string } {
  return { ...style, value: customArtStyleValue(style.id) }
}

export async function listCustomArtStylesPage(userId: string, page: EnabledListPage): Promise<CustomArtStylePage> {
  const contains = nameContains(page.filters.q)
  const where = {
    userId,
    ...(contains ? { name: contains } : {}),
    ...keysetWhere(page.cursor),
  }
  const countWhere = {
    userId,
    ...(contains ? { name: contains } : {}),
  }
  const [rows, total] = await Promise.all([
    prisma.customArtStyle.findMany({
      where,
      orderBy: [...KEYSET_ORDER_BY],
      take: page.limit + 1,
    }),
    page.cursor ? Promise.resolve(undefined) : prisma.customArtStyle.count({ where: countWhere }),
  ])
  const { page: styles, nextCursor } = sliceKeysetRows(rows, page.limit, page.filters)
  const body: CustomArtStylePage = {
    styles: styles.map((style) => presentStyle(style)),
    nextCursor,
  }
  if (total !== undefined) body.total = total
  return body
}
