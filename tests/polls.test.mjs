import assert from 'node:assert/strict'
import test from 'node:test'
import { castVote, finalizePoll, tallyVotes, validatePollOptions } from '../src/lib/polls.ts'

const future = (days) => new Date(Date.now() + days * 86400000).toISOString()
const options = [
  { id: 'opt-1', startsAt: future(1) },
  { id: 'opt-2', startsAt: future(2) },
  { id: 'opt-3', startsAt: future(3) },
]

test('poll options must be 2-5 distinct future times', () => {
  assert.match(validatePollOptions([options[0]]), /at least 2/)
  assert.match(validatePollOptions([...options, { id: 'o4', startsAt: future(4) }, { id: 'o5', startsAt: future(5) }, { id: 'o6', startsAt: future(6) }]), /at most 5/)
  assert.match(validatePollOptions([options[0], { id: 'opt-1', startsAt: future(9) }]), /unique id/)
  assert.match(validatePollOptions([options[0], { id: 'opt-2', startsAt: options[0].startsAt }]), /different/)
  assert.match(validatePollOptions([{ id: 'past', startsAt: '2020-01-01T00:00:00Z' }, options[1]]), /future/)
  assert.equal(validatePollOptions(options), null)
})

test('one user has at most one vote per option, and may vote for several options', () => {
  const ids = options.map(o => o.id)
  const first = castVote([], 'opt-1', 'user-1', ids)
  assert.equal(first.error, undefined)
  assert.equal(first.votes.length, 1)
  const repeat = castVote(first.votes, 'opt-1', 'user-1', ids)
  assert.equal(repeat.votes.length, 1)
  assert.equal(repeat.votes, first.votes, 'repeat vote returns the same list (no duplicate)')
  const secondOption = castVote(repeat.votes, 'opt-2', 'user-1', ids)
  assert.equal(secondOption.votes.length, 2)
  const otherUser = castVote(secondOption.votes, 'opt-1', 'user-2', ids)
  assert.equal(otherUser.votes.length, 3)
})

test('voting for an option outside the poll is rejected without changing the list', () => {
  const ids = options.map(o => o.id)
  const result = castVote([], 'not-an-option', 'user-1', ids)
  assert.match(result.error, /not part of this poll/)
  assert.deepEqual(result.votes, [])
})

test('tally counts votes per option', () => {
  assert.deepEqual(tallyVotes([
    { optionId: 'opt-1', userId: 'a' },
    { optionId: 'opt-1', userId: 'b' },
    { optionId: 'opt-2', userId: 'a' },
  ]), { 'opt-1': 2, 'opt-2': 1 })
  assert.deepEqual(tallyVotes([]), {})
})

test('only the host can finalise, and only to an offered option', () => {
  const ids = options.map(o => o.id)
  assert.match(finalizePoll('host', 'player', 'opt-1', ids).error, /Only the session host/)
  assert.match(finalizePoll('host', 'host', 'nope', ids).error, /not part of this poll/)
  assert.deepEqual(finalizePoll('host', 'host', 'opt-2', ids), { optionId: 'opt-2' })
})
