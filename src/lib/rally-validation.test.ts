import { describe, expect, it } from 'vitest'
import { summarizeAttendance, validateSession } from './rally'
import type { RallySession } from './rally'

const NOW = Date.parse('2026-11-21T12:00:00Z')
const valid: Omit<RallySession, 'hostId' | 'chatChannelId' | 'status'> = {
  title: 'Sunday doubles',
  court: 'Schenley Oval',
  location: 'Pittsburgh',
  startsAt: '2026-11-22T18:00:00Z',
  durationMinutes: 90,
  targetPlayers: 4,
  capacity: 4,
  level: 'Intermediate',
  notes: '',
}

describe('session input validation and legacy compatibility', () => {
  it('accepts a complete valid session', () => {
    expect(validateSession(valid, NOW)).toBeNull()
  })

  it('accepts legacy sessions with absent or null notes without crashing', () => {
    const missing = { ...valid } as Record<string, unknown>
    delete missing.notes
    expect(validateSession(missing as typeof valid, NOW)).toBeNull()
    expect(validateSession({ ...valid, notes: null } as unknown as typeof valid, NOW)).toBeNull()
  })

  it('rejects malformed notes with a useful error instead of throwing', () => {
    expect(validateSession({ ...valid, notes: { content: 'legacy' } } as unknown as typeof valid, NOW))
      .toBe('Enter valid session notes.')
    expect(validateSession({ ...valid, notes: 'a'.repeat(401) }, NOW)).toBe('Keep notes under 400 characters.')
  })

  it.each(['title', 'court', 'location'] as const)(
    'rejects malformed %s without a runtime TypeError',
    field => {
      const malformed = { ...valid, [field]: null } as unknown as typeof valid
      expect(() => validateSession(malformed, NOW)).not.toThrow()
      expect(validateSession(malformed, NOW)).toMatch(/title|court|location/i)
    },
  )

  it('still rejects past starts and capacity below the target', () => {
    expect(validateSession({ ...valid, startsAt: '2026-11-20T18:00:00Z' }, NOW)).toBe('Choose a future date and time.')
    expect(validateSession({ ...valid, capacity: 2 }, NOW)).toBe('The planning target cannot exceed the maximum.')
  })
})

describe('session detail attendance consistency', () => {
  it('counts each participant once and ignores malformed or unrelated rows', () => {
    const rows = [
      { sessionId: 's1', userId: 'alice', status: 'going' },
      { sessionId: 's1', userId: 'alice', status: 'going' },
      { sessionId: 's1', userId: 'alice', status: 'maybe' },
      { sessionId: 's1', userId: 'bob', status: 'maybe' },
      { sessionId: 's1', userId: 'charlie', status: 'unknown' },
      { sessionId: 's1', userId: '', status: 'going' },
      { sessionId: 's2', userId: 'dana', status: 'going' },
    ] as unknown as Parameters<typeof summarizeAttendance>[0]
    expect(summarizeAttendance(rows, 's1')).toEqual({ going: 1, maybe: 1 })
    expect(summarizeAttendance(rows, 's2')).toEqual({ going: 1, maybe: 0 })
  })

  it('skips an invalid row without preventing a later valid membership', () => {
    const rows = [
      { sessionId: 's1', userId: 'alice', status: 'corrupt' },
      { sessionId: 's1', userId: 'alice', status: 'going' },
      { sessionId: 's1', userId: 'bob', status: 'maybe' },
    ] as unknown as Parameters<typeof summarizeAttendance>[0]
    expect(summarizeAttendance(rows, 's1')).toEqual({ going: 1, maybe: 1 })
  })
})
