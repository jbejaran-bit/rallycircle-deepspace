import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { RallyCalendarActions } from './RallyCalendarActions'
import type { RallySession } from '@/lib/rally'
import { GOOGLE_CALENDAR_DIRECT_SAVE_ENABLED } from '@/lib/calendar-feature-flags'

const session: RallySession = { status: 'open', startsAt: '2027-04-11T19:30:00-04:00', durationMinutes: 90,
  title: 'Doubles', court: 'Court 2', location: 'Pittsburgh, PA', hostId: 'host', targetPlayers: 4,
  level: 'All levels', notes: '', chatChannelId: 'chat' }
const render = (changes = {}, userId = 'host') => renderToStaticMarkup(<RallyCalendarActions session={{ ...session, ...changes }} invitationUrl="https://rally.example/rallies?session=one" userId={userId} />)

it('renders explicit Google and .ics labels without a saved claim or direct-save control', () => {
  const html = render()
  expect(html).toContain('Add to Google Calendar')
  expect(html).toContain('Download .ics')
  expect(html).toContain('target="_blank"')
  expect(html).toContain('Review the event and select Save.')
  expect(html).toContain('Apple Calendar, Outlook')
  expect(html).not.toContain('Saved to Google Calendar')
  expect(html).not.toContain('Save directly to Google Calendar')
  expect(GOOGLE_CALENDAR_DIRECT_SAVE_ENABLED).toBe(false)
})

it('offers an explicit cancellation export without adding a cancelled Google event', () => {
  const html = render({ status: 'cancelled' })
  expect(html).toContain('rallycircle-cancellation.ics')
  expect(html).toContain('This session is cancelled.')
  expect(html).not.toContain('Add to Google Calendar')
})

it('keeps calendar actions unavailable to signed-out and unconfirmed players', () => {
  expect(render({}, '')).toBe('')
  expect(render({}, 'guest')).toBe('')
})
