import { describe, expect, it } from 'vitest'
import {
  castVote,
  finalizePoll,
  parsePollOptions,
  parsePollTally,
  serializePollOptions,
  serializePollTally,
  tallyVotes,
  validatePollOptions,
} from './polls'

const NOW = Date.parse('2026-10-20T12:00:00.000Z')
const OPTIONS = [
  { id: 'a', startsAt: '2026-10-24T18:00:00.000Z' },
  { id: 'b', startsAt: '2026-10-25T18:00:00.000Z' },
]

describe('validatePollOptions', () => {
  it('requires 2–5 distinct future times', () => {
    expect(validatePollOptions([], NOW)).toMatch(/at least 2/)
    expect(validatePollOptions([OPTIONS[0]], NOW)).toMatch(/at least 2/)
    expect(validatePollOptions([...OPTIONS, { id: 'c', startsAt: '2026-10-26T18:00:00.000Z' }], NOW)).toBeNull()
    const six = Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, startsAt: `2026-11-0${i + 1}T18:00:00.000Z` }))
    expect(validatePollOptions(six, NOW)).toMatch(/at most 5/)
    expect(validatePollOptions([OPTIONS[0], { id: 'a', startsAt: '2026-10-26T18:00:00.000Z' }], NOW)).toMatch(/unique id/)
    expect(validatePollOptions([OPTIONS[0], { id: 'b', startsAt: '2026-10-24T18:00:00.000Z' }], NOW)).toMatch(/different/)
    expect(validatePollOptions([{ id: 'a', startsAt: '2026-10-19T18:00:00.000Z' }, OPTIONS[1]], NOW)).toMatch(/in the future/)
    expect(validatePollOptions([{ id: 'a', startsAt: 'not-a-date' }, OPTIONS[1]], NOW)).toMatch(/in the future/)
  })

  it('rejects option ids over 200 characters (storage-bloat bound, ported from the PR #20 adversarial branch)', () => {
    expect(validatePollOptions([
      { id: 'x'.repeat(200), startsAt: '2026-10-26T18:00:00.000Z' },
      { id: 'b', startsAt: '2026-10-27T18:00:00.000Z' },
    ], NOW)).toBeNull()
    expect(validatePollOptions([
      { id: 'x'.repeat(201), startsAt: '2026-10-26T18:00:00.000Z' },
      { id: 'b', startsAt: '2026-10-27T18:00:00.000Z' },
    ], NOW)).toMatch(/unique id/)
    expect(validatePollOptions([
      { id: 'x'.repeat(1024 * 1024), startsAt: '2026-10-26T18:00:00.000Z' },
      { id: 'b', startsAt: '2026-10-27T18:00:00.000Z' },
    ], NOW)).toMatch(/unique id/)
    expect(validatePollOptions([
      { id: 123 as unknown as string, startsAt: '2026-10-26T18:00:00.000Z' },
      { id: 'b', startsAt: '2026-10-27T18:00:00.000Z' },
    ], NOW)).toMatch(/unique id/)
  })

  it('treats a DST fall-back instant as one unambiguous instant', () => {
    // 2026-11-01 is the US fall-back day: 01:30 local happens twice.
    // As a UTC instant it is unambiguous, and it stays in the future.
    const dst = { id: 'dst', startsAt: '2026-11-01T06:30:00.000Z' }
    const now = Date.parse('2026-10-31T12:00:00.000Z')
    expect(validatePollOptions([dst, { id: 'b', startsAt: '2026-11-02T18:00:00.000Z' }], now)).toBeNull()
    expect(Date.parse(dst.startsAt)).toBe(1793514600000)
    // The stored instant round-trips exactly; no wall-clock shift is applied.
    expect(new Date(dst.startsAt).toISOString()).toBe('2026-11-01T06:30:00.000Z')
  })
})

describe('castVote and tallyVotes', () => {
  it('is idempotent per user per option and allows several options', () => {
    const ids = OPTIONS.map(o => o.id)
    const first = castVote([], 'a', 'alice', ids)
    expect(first.votes).toEqual([{ optionId: 'a', userId: 'alice' }])
    const again = castVote(first.votes, 'a', 'alice', ids)
    expect(again.votes).toEqual(first.votes)
    expect(again.error).toBeUndefined()
    const second = castVote(first.votes, 'b', 'alice', ids)
    expect(second.votes).toHaveLength(2)
    expect(castVote(second.votes, 'c', 'alice', ids).error).toMatch(/not part of this poll/)
    expect(tallyVotes(second.votes)).toEqual({ a: 1, b: 1 })
    const bob = castVote(second.votes, 'a', 'bob', ids)
    expect(tallyVotes(bob.votes)).toEqual({ a: 2, b: 1 })
  })
})

describe('finalizePoll', () => {
  it('allows only the host to finalise to an offered option', () => {
    expect(finalizePoll('host', 'player', 'a', ['a', 'b'])).toMatchObject({ error: expect.stringContaining('host') })
    expect(finalizePoll('host', 'host', 'c', ['a', 'b'])).toMatchObject({ error: expect.stringContaining('not part') })
    expect(finalizePoll('host', 'host', 'a', ['a', 'b'])).toEqual({ optionId: 'a' })
  })
})

describe('poll JSON columns', () => {
  it('round-trips options and tally, and rejects malformed input safely', () => {
    expect(parsePollOptions(serializePollOptions(OPTIONS))).toEqual(OPTIONS)
    expect(parsePollOptions('not json')).toBeNull()
    expect(parsePollOptions('[{"id": 1}]')).toBeNull()
    expect(parsePollTally(serializePollTally({ a: 2, b: 1 }))).toEqual({ a: 2, b: 1 })
    expect(parsePollTally('{"a": "two"}')).toEqual({})
    expect(parsePollTally(undefined)).toEqual({})
  })
})
