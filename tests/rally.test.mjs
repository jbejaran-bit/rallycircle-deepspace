import assert from 'node:assert/strict'
import test from 'node:test'
import { validateSession, groupSessionRsvps, parseLocalSessionStart, summarizeAttendance, summarizeReadiness, formatSessionTime, buildSessionUrl } from '../src/lib/rally.ts'

const now = Date.parse('2030-06-15T12:00:00Z')
const future = new Date(now + 86400000).toISOString()
const validate = input => validateSession(input, now)
const base = {title:'Saturday doubles',court:'Schenley Park',location:'Pittsburgh, PA',startsAt:future,durationMinutes:90,targetPlayers:4,level:'Intermediate',notes:'Bring balls'}

test('valid session passes input validation',()=>assert.equal(validate(base),null))
test('past session rejected',()=>assert.match(validate({...base,startsAt:'2025-01-01T00:00:00Z'}),/future/))
test('empty title rejected',()=>assert.match(validate({...base,title:'   '}),/title/))
test('invalid target rejected',()=>assert.match(validate({...base,targetPlayers:1}),/2–12/))
test('malformed date rejected',()=>assert.match(validate({...base,startsAt:'never'}),/future/))
test('unsafe long notes rejected',()=>assert.match(validate({...base,notes:'x'.repeat(401)}),/400/))
test('attendance counts exclude another session',()=>assert.deepEqual(summarizeAttendance([
  {sessionId:'a',userId:'1',status:'going'}, {sessionId:'a',userId:'2',status:'maybe'},
  {sessionId:'a',userId:'3',status:'going'}, {sessionId:'b',userId:'4',status:'going'}
], 'a'), {going:2,maybe:1}))
test('readiness identifies the final player needed for doubles', () => {
  assert.deepEqual(summarizeReadiness(3, 4), {
    confirmedPlayers: 3,
    targetPlayers: 4,
    remainingToTarget: 1,
    remainingForDoubles: 1,
    ready: false,
    status: 'One more player needed',
    detail: '',
  })
})
test('readiness marks four confirmed players as ready', () => {
  assert.equal(summarizeReadiness(4, 4).status, 'Doubles ready!')
})
test('readiness separates doubles from a larger session target', () => {
  assert.deepEqual(summarizeReadiness(3, 6), {
    confirmedPlayers: 3,
    targetPlayers: 6,
    remainingToTarget: 3,
    remainingForDoubles: 1,
    ready: false,
    status: '3 more players needed',
    detail: 'One more player to make doubles.',
  })
})
test('readiness remains meaningful when target is already reached below doubles size', () => {
  assert.equal(summarizeReadiness(2, 2).status, '2 more players needed for doubles')
})
test('invalid date shows safe fallback',()=>assert.equal(formatSessionTime('invalid'), 'Time unavailable'))

test('share link preserves opaque IDs', () => {
  assert.equal(buildSessionUrl('https://rallycircle.app.space', 'a+b/2'), 'https://rallycircle.app.space/rallies?session=a%2Bb%2F2')
})
test('share link uses canonical origin', () => {
  assert.equal(buildSessionUrl('https://rallycircle.app.space/old?x=y', 'id'), 'https://rallycircle.app.space/rallies?session=id')
})
test('duration outside offered options is rejected', () => {
  assert.match(validate({...base, durationMinutes:45}), /duration/)
})
test('invalid skill level is rejected', () => {
  assert.match(validate({...base, level:'Professional'}), /skill level/)
})

test('grouped responses preserve withdrawal IDs and stay scoped to their session', () => {
  const rsvps = [
    { recordId: 'one', data: { sessionId: 'a', userId: 'player-1', status: 'going' } },
    { recordId: 'two', data: { sessionId: 'b', userId: 'player-1', status: 'maybe' } },
    { recordId: 'three', data: { sessionId: 'a', userId: 'player-2', status: 'maybe' } },
  ]
  const grouped = groupSessionRsvps(rsvps)
  assert.deepEqual(grouped.get('a').map(record => record.recordId), ['one', 'three'])
  assert.deepEqual(grouped.get('b'), [rsvps[1]])
  assert.equal(grouped.has('unknown'), false)

  const afterWithdrawal = groupSessionRsvps(rsvps.filter(record => record.recordId !== 'one'))
  assert.deepEqual(afterWithdrawal.get('a'), [rsvps[2]])
  assert.deepEqual(afterWithdrawal.get('b'), [rsvps[1]])
})

test('readiness reflects singles and practice formats', () => {
  assert.equal(summarizeReadiness(2, 3, 'Singles').status, 'Singles ready!')
  assert.equal(summarizeReadiness(1, 3, 'Singles').status, '2 more players needed')
  assert.equal(summarizeReadiness(2, 3, 'Practice').status, 'One more player needed')
  assert.equal(summarizeReadiness(3, 3, 'Practice').status, 'Target reached')
})

test('a session maximum must cover its planning target', () => {
  assert.match(validate({ ...base, capacity: 3 }), /target cannot exceed/)
  assert.match(validate({ ...base, capacity: 4.5 }), /capacity/)
  assert.equal(validate({ ...base, capacity: 4 }), null)
})

test('local session times round-trip without silently changing impossible dates', () => {
  const date = parseLocalSessionStart('2026-11-20T17:30')
  assert.equal(date?.getHours(), 17)
  assert.equal(date?.getMinutes(), 30)
  assert.equal(parseLocalSessionStart('2026-02-30T17:30'), null)
  assert.equal(parseLocalSessionStart('2026-11-20T24:00'), null)
  assert.equal(parseLocalSessionStart('2026-11-20T17:30Z'), null)
})

test('New York local input rejects the skipped hour at the spring DST change', () => {
  const previousZone = process.env.TZ
  try {
    process.env.TZ = 'America/New_York'
    assert.equal(parseLocalSessionStart('2027-03-14T02:30'), null)
    assert.equal(parseLocalSessionStart('2027-03-14T01:30')?.toISOString(), '2027-03-14T06:30:00.000Z')
    assert.equal(parseLocalSessionStart('2027-03-14T03:30')?.toISOString(), '2027-03-14T07:30:00.000Z')
  } finally {
    if (previousZone === undefined) delete process.env.TZ
    else process.env.TZ = previousZone
  }
})
