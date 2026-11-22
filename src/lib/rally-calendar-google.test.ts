import { describe, expect, it } from 'vitest'
import { buildCalendarEvent, buildGoogleCalendarUrl, calendarDetails, calendarTimeZone } from './rally-calendar'

const session = {
  status: 'open', startsAt: '2027-04-11T19:30:00-04:00', durationMinutes: 90,
  title: 'Doubles & practice 🎾', court: 'Court 2', location: 'Pittsburgh, PA',
  format: 'Doubles', level: 'Intermediate', notes: 'Bring balls & water.\nMeet at the gate.',
} as const
const invitation = 'https://rally.example/rallies?session=a%2Fb%26c'
const params = (changes = {}, zone = 'America/New_York') => new URL(buildGoogleCalendarUrl({ ...session, ...changes }, invitation, zone)!).searchParams

describe('Google Calendar event editor', () => {
  it('populates the title, UTC start/end, display time zone, court, notes and invitation', () => {
    const url = new URL(buildGoogleCalendarUrl(session, invitation, 'America/New_York')!)
    expect(url.origin).toBe('https://calendar.google.com')
    expect(url.pathname).toBe('/calendar/render')
    expect(url.searchParams.get('action')).toBe('TEMPLATE')
    expect(url.searchParams.get('text')).toBe(session.title)
    expect(url.searchParams.get('dates')).toBe('20270411T233000Z/20270412T010000Z')
    expect(url.searchParams.get('ctz')).toBe('America/New_York')
    expect(url.searchParams.get('location')).toBe('Court 2, Pittsburgh, PA')
    expect(url.searchParams.get('details')).toBe(`Format: Doubles\nLevel: Intermediate\n${session.notes}\nView rally: ${invitation}`)
  })

  it.each([60, 90, 120, 150])('keeps the configured %i-minute duration', durationMinutes => {
    const details = calendarDetails({ ...session, durationMinutes }, invitation)!
    expect(details.end.getTime() - details.start.getTime()).toBe(durationMinutes * 60_000)
  })

  it('preserves the instant when the viewing time zone changes', () => {
    const ny = params({}, 'America/New_York')
    const tokyo = params({}, 'Asia/Tokyo')
    expect(ny.get('dates')).toBe(tokyo.get('dates'))
    expect(tokyo.get('ctz')).toBe('Asia/Tokyo')
  })

  it.each([
    ['2026-03-08T01:30:00-05:00', '20260308T063000Z/20260308T080000Z'],
    ['2026-11-01T01:30:00-04:00', '20261101T053000Z/20261101T070000Z'],
    ['2026-11-01T01:30:00-05:00', '20261101T063000Z/20261101T080000Z'],
    ['2027-04-12T09:00:00+09:00', '20270412T000000Z/20270412T013000Z'],
  ])('handles daylight saving and offset starts: %s', (startsAt, expected) => {
    expect(params({ startsAt }).get('dates')).toBe(expected)
  })

  it.each(['2027-02-30T12:00:00Z', '2027-04-11T19:30', 'invalid', '2027-04-11T24:30:00Z'])('rejects ambiguous or invalid dates: %s', startsAt => {
    expect(buildGoogleCalendarUrl({ ...session, startsAt }, invitation)).toBeNull()
    expect(buildCalendarEvent({ ...session, startsAt }, invitation)).toBeNull()
  })

  it.each([0, -1, NaN, Infinity])('rejects unusable durations: %s', durationMinutes => {
    expect(buildGoogleCalendarUrl({ ...session, durationMinutes }, invitation)).toBeNull()
  })

  it.each(['javascript:alert(1)', 'https://user:secret@rally.example/rallies', 'https://rally.example/rallies\r\nX:bad', '/rallies'])('rejects unsafe invitation URLs: %s', url => {
    expect(buildGoogleCalendarUrl(session, url)).toBeNull()
  })

  it('does not open a new event for a cancelled session', () => {
    expect(buildGoogleCalendarUrl({ ...session, status: 'cancelled' }, invitation)).toBeNull()
  })

  it('falls back to UTC for an invalid time zone', () => {
    expect(calendarTimeZone('not/a-zone')).toBe('UTC')
    expect(params({}, 'not/a-zone').get('ctz')).toBe('UTC')
  })

  it('keeps encoded invitation ids intact and shares the same event data with .ics', () => {
    const data = buildCalendarEvent(session, invitation)!.replace(/\r\n /g, '')
    expect(params().get('details')).toContain(`View rally: ${invitation}`)
    expect(data).toContain(`URL:${invitation}`)
    expect(data).toContain('Bring balls & water.\\nMeet at the gate.')
  })
})
