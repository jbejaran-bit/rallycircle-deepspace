import { integration, type IntegrationResponse } from 'deepspace'
import { GOOGLE_CALENDAR_DIRECT_SAVE_ENABLED } from './calendar-feature-flags'
import { calendarDetails, type CalendarSession } from './rally-calendar'

export type GoogleCalendarSaveResult =
  | { state: 'disabled' }
  | { state: 'authorization'; authUrl: string }
  | { state: 'saved'; eventId: string; eventUrl?: string }
  | { state: 'error' | 'uncertain' | 'reconnect'; message: string }

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function safeGoogleUrl(value: unknown, auth = false): string | null {
  if (typeof value !== 'string') return null
  const url = URL.parse(value)
  const hosts = auth ? ['accounts.google.com', 'auth.deep.space', 'app.space'] : ['calendar.google.com', 'www.google.com']
  return url?.protocol === 'https:' && !url.username && !url.password && hosts.includes(url.hostname) ? url.href : null
}

/** Success-shaped OAuth replies do not mean that Google created an event. */
export function readGoogleCalendarSaveResult(result: IntegrationResponse): GoogleCalendarSaveResult {
  if (!result.success) {
    const message = result.error || 'Google Calendar could not save this session.'
    if (/Token refresh failed/i.test(message) || /Token refresh failed/i.test(String(result.details?.message ?? ''))) {
      return { state: 'reconnect', message: 'Google authorization expired. Disconnect and reconnect Google before saving, or use Add to Google Calendar.' }
    }
    // A timeout, network failure or provider failure can follow an accepted write.
    if (!result.status || result.status >= 500) return { state: 'uncertain', message: 'Google did not confirm the save. Check your calendar before trying again to avoid a duplicate.' }
    return { state: 'error', message }
  }
  const payload = object(result.data ?? result)
  if (payload?.requiresOAuth === true) {
    const authUrl = safeGoogleUrl(payload.authUrl, true)
    return authUrl
      ? { state: 'authorization', authUrl }
      : { state: 'error', message: 'Google did not provide a valid connection link. Use Add to Google Calendar and try direct saving later.' }
  }
  // The catalog publishes no output schema. Require Google's explicit confirmation
  // and event id; an unrecognized reply must never be presented as a saved event.
  const event = object(payload?.event) ?? payload
  if (event?.status === 'confirmed' && typeof event.id === 'string' && event.id.length > 0) {
    const eventUrl = safeGoogleUrl(event.htmlLink)
    return { state: 'saved', eventId: event.id, ...(eventUrl ? { eventUrl } : {}) }
  }
  return { state: 'uncertain', message: 'Google did not confirm the save. Check your calendar before trying again to avoid a duplicate.' }
}

/** Never runs on mount or after OAuth automatically. One deliberate save makes one request. */
export async function saveGoogleCalendarEvent(session: CalendarSession, invitation: string): Promise<GoogleCalendarSaveResult> {
  if (!GOOGLE_CALENDAR_DIRECT_SAVE_ENABLED) return { state: 'disabled' }
  const details = session.status === 'open' ? calendarDetails(session, invitation) : null
  if (!details) return { state: 'error', message: 'This session cannot be added to a calendar. Check its date and invitation link.' }
  try {
    return readGoogleCalendarSaveResult(await integration.post('google/calendar-create-event', {
      calendarId: 'primary', title: details.title,
      start: details.start.toISOString(), end: details.end.toISOString(),
      description: details.description, location: details.location,
      allDay: false, sendUpdates: 'none', addVideoConferencing: false,
    }, { timeoutMs: 30_000 }))
  } catch {
    return { state: 'uncertain', message: 'Google did not confirm the save. Check your calendar before trying again to avoid a duplicate.' }
  }
}

/** Disconnect is an explicit user action, only offered for revoked/expired authorization. */
export async function disconnectCalendarGoogle(): Promise<string | null> {
  if (!GOOGLE_CALENDAR_DIRECT_SAVE_ENABLED) return 'Direct calendar saving is not enabled.'
  try {
    const result = await integration.delete('oauth/google/disconnect')
    return result.success ? null : result.error || 'Google could not be disconnected. Try again later.'
  } catch {
    return 'Google could not be disconnected. Check your connection and try again.'
  }
}
