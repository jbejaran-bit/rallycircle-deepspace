// Node headline tests for the RallyCircle Rating engine (algorithm v1).
// Imports the pure engine directly; no server, no records, no network.
// Run: node --test tests/rating.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyFinalizedResult,
  expectedScore,
  kFactor,
  resultIdFor,
  reverseChange,
  validateFinalizedInput,
} from '../src/lib/rating.ts'

test('equal new players split 20 points', () => {
  const outcome = applyFinalizedResult(
    { resultId: resultIdFor('s1', 3), sessionId: 's1', format: 'Singles', teams: [['ana'], ['bea']], winner: 0 },
    new Map(),
  )
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.deepEqual(
    outcome.changes.map(c => [c.playerId, c.before, c.after, c.delta]),
    [['ana', 1200, 1220, 20], ['bea', 1200, 1180, -20]],
  )
})

test('upset win is worth more: 1220 beats 1400 for +30', () => {
  const states = new Map([
    ['ana', { playerId: 'ana', rating: 1220, matchesPlayed: 1 }],
    ['cara', { playerId: 'cara', rating: 1400, matchesPlayed: 5 }],
  ])
  const outcome = applyFinalizedResult(
    { resultId: resultIdFor('s1', 4), sessionId: 's1', format: 'Singles', teams: [['ana'], ['cara']], winner: 0 },
    states,
  )
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.equal(outcome.changes[0].delta, 30)
  assert.equal(outcome.changes[1].delta, -30)
})

test('expected score: 0.5 equal, ~0.91 for a 400-point favourite', () => {
  assert.equal(expectedScore(1200, 1200), 0.5)
  assert.ok(Math.abs(expectedScore(1600, 1200) - 0.909) < 0.001)
})

test('K steps down with matches played and halves for repeat opponents', () => {
  assert.equal(kFactor(0, 0), 40)
  assert.equal(kFactor(10, 0), 32)
  assert.equal(kFactor(30, 0), 24)
  assert.equal(kFactor(0, 3), 20)
})

test('self-play is rejected', () => {
  const error = validateFinalizedInput(
    { resultId: 'x', sessionId: 's', format: 'Singles', teams: [['ana'], ['ana']], winner: 0 },
  )
  assert.match(error ?? '', /both sides/)
})

test('doubles uses team means; lower-rated partner gains more from an upset', () => {
  const states = new Map([
    ['ana', { playerId: 'ana', rating: 1100, matchesPlayed: 0 }],
    ['dan', { playerId: 'dan', rating: 1500, matchesPlayed: 0 }],
    ['bea', { playerId: 'bea', rating: 1300, matchesPlayed: 0 }],
    ['cara', { playerId: 'cara', rating: 1300, matchesPlayed: 0 }],
  ])
  const outcome = applyFinalizedResult(
    { resultId: resultIdFor('s3', 1), sessionId: 's3', format: 'Doubles', teams: [['ana', 'dan'], ['bea', 'cara']], winner: 0 },
    states,
  )
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  const byId = new Map(outcome.changes.map(c => [c.playerId, c]))
  assert.ok((byId.get('ana')?.delta ?? 0) > (byId.get('dan')?.delta ?? 0))
  assert.equal(byId.get('ana')?.delta, 30)
  assert.equal(byId.get('dan')?.delta, 10)
})

test('reversal negates the change', () => {
  const outcome = applyFinalizedResult(
    { resultId: resultIdFor('s1', 3), sessionId: 's1', format: 'Singles', teams: [['ana'], ['bea']], winner: 0 },
    new Map(),
  )
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  const reversed = reverseChange(outcome.changes[0])
  assert.deepEqual([reversed.before, reversed.after, reversed.delta], [1220, 1200, -20])
  assert.equal(reversed.matchesPlayedAfter, 0)
})

test('result ids are stable idempotency keys', () => {
  assert.equal(resultIdFor('abc', 3), 'session:abc:rev:3')
})
