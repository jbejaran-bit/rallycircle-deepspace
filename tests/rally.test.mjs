import assert from 'node:assert/strict'
import test from 'node:test'
import { validateSession, summarizeAttendance, summarizeReadiness, formatSessionTime, buildSessionUrl, resolveCapacity, waitlistPosition } from '../src/lib/rally.ts'

const future = new Date(Date.now() + 86400000).toISOString()
const base = {title:'Saturday doubles',court:'Schenley Park',location:'Pittsburgh, PA',startsAt:future,durationMinutes:90,targetPlayers:4,level:'Intermediate',notes:'Bring balls'}

test('valid session passes input validation',()=>assert.equal(validateSession(base),null))
test('past session rejected',()=>assert.match(validateSession({...base,startsAt:'2025-01-01T00:00:00Z'}),/future/))
test('empty title rejected',()=>assert.match(validateSession({...base,title:'   '}),/title/))
test('invalid target rejected',()=>assert.match(validateSession({...base,targetPlayers:1}),/2–12/))
test('malformed date rejected',()=>assert.match(validateSession({...base,startsAt:'never'}),/future/))
test('unsafe long notes rejected',()=>assert.match(validateSession({...base,notes:'x'.repeat(401)}),/400/))
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
  assert.match(validateSession({...base, durationMinutes:45}), /duration/)
})
test('invalid skill level is rejected', () => {
  assert.match(validateSession({...base, level:'Professional'}), /skill level/)
})

test('capacity resolves open by default for old sessions', () => {
  assert.deepEqual(resolveCapacity({}), { limited: false, maxPlayers: 0 })
  assert.deepEqual(resolveCapacity({ capacityMode: 'open', maxPlayers: 4 }), { limited: false, maxPlayers: 0 })
  assert.deepEqual(resolveCapacity({ capacityMode: 'limited', maxPlayers: 4 }), { limited: true, maxPlayers: 4 })
})
test('capacity treats a malformed stored cap as open, never clamps it', () => {
  assert.deepEqual(resolveCapacity({ capacityMode: 'limited', maxPlayers: 99 }), { limited: false, maxPlayers: 0 })
  assert.deepEqual(resolveCapacity({ capacityMode: 'limited', maxPlayers: 1 }), { limited: false, maxPlayers: 0 })
  assert.deepEqual(resolveCapacity({ capacityMode: 'limited' }), { limited: false, maxPlayers: 0 })
})
test('waitlist position is FIFO by createdAt with recordId tiebreak', () => {
  const rows = [
    { recordId: 'b', createdAt: '2026-01-01T00:00:02.000Z', data: { sessionId: 's', userId: 'w2' } },
    { recordId: 'a', createdAt: '2026-01-01T00:00:01.000Z', data: { sessionId: 's', userId: 'w1' } },
    { recordId: 'c', createdAt: '2026-01-01T00:00:01.000Z', data: { sessionId: 's', userId: 'w3' } },
    { recordId: 'd', createdAt: '2026-01-01T00:00:03.000Z', data: { sessionId: 'other', userId: 'w1' } },
  ]
  assert.equal(waitlistPosition(rows, 's', 'w1'), 1)
  assert.equal(waitlistPosition(rows, 's', 'w3'), 2)
  assert.equal(waitlistPosition(rows, 's', 'w2'), 3)
  assert.equal(waitlistPosition(rows, 's', 'nobody'), 0)
})
test('limited session validation requires 2-12 max players', () => {
  assert.equal(validateSession({ ...base, capacityMode: 'limited', maxPlayers: 4 }), null)
  assert.match(validateSession({ ...base, capacityMode: 'limited', maxPlayers: 1 }), /2–12 maximum players/)
  assert.match(validateSession({ ...base, capacityMode: 'limited' }), /2–12 maximum players/)
  assert.match(validateSession({ ...base, capacityMode: 'capped', maxPlayers: 4 }), /open or limited/)
  assert.equal(validateSession({ ...base, capacityMode: 'open', maxPlayers: 0 }), null)
})
