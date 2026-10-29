import { describe, expect, it } from 'vitest'
import { formatDefaultProjectTimestamp } from '@/lib/projects/default-name'

describe('default project name timestamp', () => {
  it('formats month-day and hour-minute without year', () => {
    // Local calendar fields stay 2026-03-29 18:56 in any process timezone.
    // An offset instant such as 2026-03-29T18:56:42+08:00 is 10:56 UTC, and
    // formatDefaultProjectTimestamp reads Date local getters with no timezone argument.
    const date = new Date(2026, 2, 29, 18, 56, 42)
    expect(formatDefaultProjectTimestamp(date)).toBe('03-29 18:56')
  })
})
