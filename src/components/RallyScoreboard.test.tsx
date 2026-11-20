import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import RallyScoreboard from './RallyScoreboard'
import { createMatchScore } from '@/lib/rally-score'
import type { RallySession } from '@/lib/rally'

const score = createMatchScore([['host'], ['guest']])
const base: RallySession = {
  title: 'Singles', format: 'Singles', court: 'Court', location: 'Park',
  startsAt: '2026-12-01T12:00:00Z', durationMinutes: 90, targetPlayers: 2,
  level: 'All levels', hostId: 'host', chatChannelId: '', notes: '', status: 'open',
}
const nameOf = (id: string) => id === 'host' ? 'Alex' : 'Sam'

function render(userId: string, session: RallySession) {
  return renderToStaticMarkup(<RallyScoreboard session={session} sessionId="match"
    userId={userId} isHost={userId === 'host'} players={[]} nameOf={nameOf} />)
}

it('renders real player names and point controls only for the host', () => {
  const session = { ...base, matchScore: JSON.stringify(score) }
  expect(render('host', session)).toContain('Point to side')
  const observer = render('guest', session)
  expect(observer).toContain('Alex')
  expect(observer).toContain('Sam')
  expect(observer).not.toContain('Point to side')
  expect(render('host', { ...session, status: 'cancelled' })).toContain('Scoring closed.')
  expect(render('host', { ...session, status: 'cancelled' })).not.toContain('Point to side')
})

it('offers result review only to recorded participants who still need to vote', () => {
  const result = { ...score, winner: 0, sets: [[6, 2], [6, 4]], approvals: ['host'] }
  const session = { ...base, matchScore: JSON.stringify(result) }
  expect(render('guest', session)).toContain('Dispute result')
  expect(render('host', session)).not.toContain('Dispute result')
  expect(render('other', session)).not.toContain('Confirm result')
})
