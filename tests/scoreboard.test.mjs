import assert from 'node:assert/strict'
import test from 'node:test'
import { formatSetScores, isValidMatchTiebreak, isValidSetScore, matchTiebreakWinner, scoreboardWinner, setsWon, validateScoreboardInput } from '../src/lib/scoreboard.ts'

const base = {
  teamAName: 'Alice / Bob',
  teamBName: 'Carol / Dan',
  status: 'final',
  sets: [{ a: 6, b: 4 }, { a: 6, b: 3 }],
  matchTiebreak: null,
}

const current = {
  status: 'final',
  version: 1,
  teamAName: 'Alice / Bob',
  teamBName: 'Carol / Dan',
  sets: [{ a: 6, b: 4 }, { a: 6, b: 3 }],
  matchTiebreak: null,
}

test('valid final 2-0 score passes', () => assert.equal(validateScoreboardInput(base, null), null))
test('valid final 2-1 in three sets passes', () => {
  const input = {
    ...base,
    sets: [{ a: 6, b: 4 }, { a: 3, b: 6 }, { a: 6, b: 2 }],
    matchTiebreak: null,
  }
  assert.equal(validateScoreboardInput(input, null), null)
})
test('valid deciding tiebreak 10-7 when sets split 1-1 passes', () => {
  const input = {
    ...base,
    sets: [{ a: 6, b: 4 }, { a: 3, b: 6 }],
    matchTiebreak: { a: 10, b: 7 },
  }
  assert.equal(validateScoreboardInput(input, null), null)
  assert.equal(matchTiebreakWinner({ a: 10, b: 7 }), 'A')
  assert.equal(matchTiebreakWinner({ a: 9, b: 7 }), null)
  assert.equal(matchTiebreakWinner({ a: 12, b: 10 }), 'A')
})
test('valid in-progress score passes', () => {
  assert.equal(validateScoreboardInput({ ...base, status: 'in_progress', sets: [{ a: 6, b: 4 }] }, null), null)
})
test('not started with no sets passes', () => {
  assert.equal(validateScoreboardInput({ ...base, status: 'not_started', sets: [], matchTiebreak: null }, null), null)
})

test('set scores follow tennis rules', () => {
  for (const valid of [{ a: 6, b: 0 }, { a: 6, b: 4 }, { a: 7, b: 5 }, { a: 7, b: 6 }, { a: 4, b: 6 }]) {
    assert.equal(isValidSetScore(valid), true, JSON.stringify(valid))
  }
  for (const invalid of [{ a: 6, b: 6 }, { a: 6, b: 5 }, { a: 8, b: 0 }, { a: -1, b: 3 }, { a: 0, b: 0 }, { a: 5, b: 5 }, { a: 6.5, b: 4 }]) {
    assert.equal(isValidSetScore(invalid), false, JSON.stringify(invalid))
  }
})
test('invalid set score rejected', () => {
  assert.match(validateScoreboardInput({ ...base, sets: [{ a: 6, b: 6 }] }, null) ?? '', /valid completed score/)
  assert.match(validateScoreboardInput({ ...base, sets: [{ a: 8, b: 0 }] }, null) ?? '', /valid completed score/)
  assert.match(validateScoreboardInput({ ...base, sets: [{ a: 6, b: 4 }, { a: 6, b: 4 }, { a: 6, b: 4 }, { a: 6, b: 4 }] }, null) ?? '', /at most 3 sets/)
})
test('match tiebreak needs split sets', () => {
  assert.match(validateScoreboardInput({ ...base, matchTiebreak: { a: 10, b: 7 } }, null) ?? '', /split 1–1/)
  assert.equal(isValidMatchTiebreak({ a: 10, b: 10 }), true)
  assert.equal(isValidMatchTiebreak({ a: -1, b: 3 }), false)
})
test('final match needs a winner', () => {
  assert.match(validateScoreboardInput({ ...base, sets: [{ a: 6, b: 4 }] }, null) ?? '', /needs a winner/)
  // Split sets decided by the tiebreak: the tiebreak winner is the match winner.
  const decided = { ...base, sets: [{ a: 6, b: 4 }, { a: 3, b: 6 }], matchTiebreak: { a: 7, b: 10 } }
  assert.equal(validateScoreboardInput(decided, null), null)
  assert.equal(scoreboardWinner(decided), 'B')
})
test('final match with undecided tiebreak rejected', () => {
  assert.match(
    validateScoreboardInput({ ...base, sets: [{ a: 6, b: 4 }, { a: 3, b: 6 }], matchTiebreak: { a: 9, b: 7 } }, null) ?? '',
    /tiebreak needs a winner/,
  )
})
test('in-progress match cannot already be decided', () => {
  assert.match(validateScoreboardInput({ ...base, status: 'in_progress' }, null) ?? '', /mark it final/)
})
test('not-started match cannot have set scores', () => {
  assert.match(validateScoreboardInput({ ...base, status: 'not_started' }, null) ?? '', /has not started/)
})
test('team names validated', () => {
  assert.match(validateScoreboardInput({ ...base, teamAName: '   ' }, null) ?? '', /Team A/)
  assert.match(validateScoreboardInput({ ...base, teamBName: 'x'.repeat(41) }, null) ?? '', /Team B/)
})
test('final score needs an explicit correction to change', () => {
  const changed = { ...base, sets: [{ a: 6, b: 4 }, { a: 7, b: 5 }] }
  assert.match(validateScoreboardInput(changed, current, false) ?? '', /correction/)
  assert.equal(validateScoreboardInput(changed, current, true), null)
  assert.equal(validateScoreboardInput(base, current, false), null, 'identical re-save is not a correction')
})
test('final match cannot be reopened', () => {
  assert.match(validateScoreboardInput({ ...base, status: 'in_progress' }, current, true) ?? '', /stays final/)
})
test('winner and formatting helpers', () => {
  assert.deepEqual(setsWon([{ a: 6, b: 4 }, { a: 3, b: 6 }, { a: 6, b: 2 }]), { a: 2, b: 1 })
  assert.equal(scoreboardWinner({ sets: [{ a: 6, b: 4 }, { a: 6, b: 3 }], matchTiebreak: null }), 'A')
  assert.equal(scoreboardWinner({ sets: [{ a: 6, b: 4 }], matchTiebreak: null }), null)
  assert.equal(formatSetScores([{ a: 6, b: 4 }, { a: 3, b: 6 }]), '6–4, 3–6')
  assert.equal(formatSetScores([]), '')
})
