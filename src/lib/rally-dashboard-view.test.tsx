import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import DashboardPage from '../pages/(app)/(protected)/dashboard'
import type { RallySession } from './rally'

const fixtures = vi.hoisted(() => ({
  queries: new Map<string, { status: 'ready' | 'error'; records: unknown[] }>(),
}))

vi.mock('deepspace', () => ({
  useAuth: () => ({ userId: 'host' }),
  useUser: () => ({ user: null }),
  useUserLookup: () => ({ getName: () => null }),
  useQuery: (name: string) => fixtures.queries.get(name) ?? { status: 'ready', records: [] },
}))

afterEach(() => fixtures.queries.clear())

function renderDashboard() {
  return renderToStaticMarkup(<MemoryRouter><DashboardPage /></MemoryRouter>)
}

it('keeps the current rally actionable when the separate waitlist subscription fails', () => {
  const session: RallySession = {
    title: 'After-work singles', format: 'Singles', startsAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    durationMinutes: 90, targetPlayers: 2, level: 'All levels', court: 'Tennis courts', location: 'City park',
    hostId: 'host', chatChannelId: '', notes: '', status: 'open',
  }
  fixtures.queries.set('sessions', { status: 'ready', records: [{ recordId: 'session/safe id', data: session }] })
  fixtures.queries.set('waitlists', { status: 'error', records: [] })

  const html = renderDashboard()
  expect(html).toContain('My sessions')
  expect(html).toContain('Scheduled now')
  expect(html).toContain('Waitlist status is unavailable. Your other sessions are still shown.')
  expect(html).toContain('href="/rallies?session=session%2Fsafe+id"')
  expect(html).not.toContain('Your latest activity could not be loaded.')
})

it('offers a real discovery action when nothing is planned', () => {
  const html = renderDashboard()
  expect(html).toContain('You have no upcoming sessions.')
  expect(html).toContain('href="/games"')
  expect(html).not.toContain('Results to review')
})
