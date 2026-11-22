import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ enabled: true, post: vi.fn(), delete: vi.fn() }))
vi.mock('./calendar-feature-flags', () => ({ get GOOGLE_CALENDAR_DIRECT_SAVE_ENABLED() { return mocks.enabled } }))
vi.mock('deepspace', () => ({ integration: { post: mocks.post, delete: mocks.delete } }))
import { disconnectCalendarGoogle, readGoogleCalendarSaveResult, saveGoogleCalendarEvent } from './google-calendar-save'

const session = {
  status: 'open', startsAt: '2027-04-11T19:30:00-04:00', durationMinutes: 90,
  title: 'Doubles', court: 'Court 2', location: 'Pittsburgh, PA', notes: 'Bring balls.',
} as const
const invitation = 'https://rally.example/rallies?session=one'

beforeEach(() => { mocks.enabled = true; mocks.post.mockReset(); mocks.delete.mockReset() })

describe('source-gated OAuth save', () => {
  it('makes no integration request while disabled, including disconnect', async () => {
    mocks.enabled = false
    expect(await saveGoogleCalendarEvent(session, invitation)).toEqual({ state: 'disabled' })
    await disconnectCalendarGoogle()
    expect(mocks.post).not.toHaveBeenCalled()
    expect(mocks.delete).not.toHaveBeenCalled()
  })

  it('makes one correctly shaped request and only then reports Google confirmation', async () => {
    mocks.post.mockResolvedValue({ success: true, data: { id: 'g1', status: 'confirmed', htmlLink: 'https://calendar.google.com/calendar/event?eid=g1' } })
    expect(await saveGoogleCalendarEvent(session, invitation)).toEqual({ state: 'saved', eventId: 'g1', eventUrl: 'https://calendar.google.com/calendar/event?eid=g1' })
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith('google/calendar-create-event', {
      calendarId: 'primary', title: 'Doubles', start: '2027-04-11T23:30:00.000Z', end: '2027-04-12T01:00:00.000Z',
      description: `Bring balls.\nView rally: ${invitation}`, location: 'Court 2, Pittsburgh, PA', allDay: false, sendUpdates: 'none', addVideoConferencing: false,
    }, { timeoutMs: 30_000 })
  })

  it('returns an authorization link without claiming saved or retrying', async () => {
    mocks.post.mockResolvedValue({ success: true, data: { requiresOAuth: true, authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?mock' } })
    expect(await saveGoogleCalendarEvent(session, invitation)).toEqual({ state: 'authorization', authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?mock' })
    expect(mocks.post).toHaveBeenCalledTimes(1)
  })

  it('does not call Google for cancelled or invalid sessions', async () => {
    expect((await saveGoogleCalendarEvent({ ...session, status: 'cancelled' }, invitation)).state).toBe('error')
    expect((await saveGoogleCalendarEvent({ ...session, durationMinutes: 0 }, invitation)).state).toBe('error')
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it.each([
    { success: true, data: {} },
    { success: true, data: { id: 'g1' } },
    { success: true, data: { status: 'confirmed' } },
    { success: true, data: { id: 'g1', status: 'cancelled' } },
    { success: false, status: 504, error: 'Timed out' },
    { success: false, status: 0, error: 'Network error' },
  ])('treats unconfirmed or ambiguous results as uncertain: %j', result => {
    expect(readGoogleCalendarSaveResult(result).state).toBe('uncertain')
  })

  it('preserves a known billing rejection without reporting a save', () => {
    expect(readGoogleCalendarSaveResult({ success: false, status: 402, error: 'Insufficient credits.', code: 'insufficient_credits' })).toEqual({ state: 'error', message: 'Insufficient credits.' })
  })

  it('handles revoked/expired authorization as reconnect, not a retry loop', () => {
    expect(readGoogleCalendarSaveResult({ success: false, status: 502, error: 'Token refresh failed: revoked' }).state).toBe('reconnect')
  })

  it('rejects an unsafe OAuth URL', () => {
    expect(readGoogleCalendarSaveResult({ success: true, data: { requiresOAuth: true, authUrl: 'javascript:alert(1)' } }).state).toBe('error')
  })

  it('does not trust event links outside Google', () => {
    expect(readGoogleCalendarSaveResult({ success: true, data: { id: 'g1', status: 'confirmed', htmlLink: 'https://example.com' } })).toEqual({ state: 'saved', eventId: 'g1' })
  })

  it('does not retry a thrown transport failure', async () => {
    mocks.post.mockRejectedValue(new Error('Network interrupted'))
    expect((await saveGoogleCalendarEvent(session, invitation)).state).toBe('uncertain')
    expect(mocks.post).toHaveBeenCalledTimes(1)
  })

  it('disconnects only on explicit request and uses the documented endpoint', async () => {
    mocks.delete.mockResolvedValue({ success: true })
    expect(await disconnectCalendarGoogle()).toBeNull()
    expect(mocks.delete).toHaveBeenCalledExactlyOnceWith('oauth/google/disconnect')
  })
})
