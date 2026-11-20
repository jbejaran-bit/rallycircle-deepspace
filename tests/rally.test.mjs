import assert from 'node:assert/strict'
import test from 'node:test'
import { validateSession, summarizeAttendance, summarizeReadiness, formatSessionTime, buildSessionUrl } from '../src/lib/rally.ts'

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
