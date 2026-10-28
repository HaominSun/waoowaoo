import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const memberCreateRoutes = [
  'src/app/api/organizations/[id]/members/route.ts',
  'src/app/api/organizations/route.ts',
  'src/app/api/platform/organizations/[id]/members/route.ts',
  'src/app/api/platform/organizations/route.ts',
  'src/app/api/platform/users/[id]/organizations/route.ts',
]

describe('regression - new members are not stored with the legacy unlimited sentinel', () => {
  it('writes quota null so a new member stays unlimited under both the live gate and the new cap', () => {
    for (const relativePath of memberCreateRoutes) {
      const source = readFileSync(path.join(process.cwd(), relativePath), 'utf8')
      expect(source, relativePath).toContain('quota: null')
      expect(source, relativePath).not.toMatch(/quota:\s*0\b/)
    }
  })
})
