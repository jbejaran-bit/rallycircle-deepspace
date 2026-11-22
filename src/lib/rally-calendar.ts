import type { RallySession, RSVPStatus } from './rally'

const encoder = new TextEncoder()

export type CalendarSession = Pick<RallySession, 'status' | 'startsAt' | 'durationMinutes' | 'title' | 'court' | 'location'>
  & Partial<Pick<RallySession, 'format' | 'level' | 'notes' | 'scheduleRevision'>>

export function calendarTimeZone(timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

/** A stored session is an instant, never a floating wall time interpreted by the viewer. */
export function calendarDetails(session: CalendarSession, invitation: string) {
  const url = URL.parse(invitation)
  if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || /[\r\n]/.test(invitation)) return null
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(session.startsAt)
  if (!parts) return null
  const [, year, month, day, hour, minute, second = '0'] = parts
  const wallDay = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  if (Number(year) < 1000 || wallDay.getUTCFullYear() !== Number(year) || wallDay.getUTCMonth() + 1 !== Number(month)
    || wallDay.getUTCDate() !== Number(day) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null
  const start = new Date(session.startsAt)
  const end = new Date(start.getTime() + session.durationMinutes * 60_000)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || !Number.isFinite(session.durationMinutes)
    || end <= start || end.getUTCFullYear() > 9999) return null
  return {
    start, end, invitation: url.href,
    title: session.title,
    location: [session.court, session.location].filter(Boolean).join(', '),
    description: [
      session.format && `Format: ${session.format}`,
      session.level && `Level: ${session.level}`,
      session.notes?.trim(),
      `View rally: ${url.href}`,
    ].filter(Boolean).join('\n'),
  }
}

/** Opens Google's event editor. Only the person pressing Save there creates an event. */
export function buildGoogleCalendarUrl(session: CalendarSession, invitation: string, timeZone?: string): string | null {
  if (session.status !== 'open') return null
  const details = calendarDetails(session, invitation)
  if (!details) return null
  const url = new URL('https://calendar.google.com/calendar/render')
  url.search = new URLSearchParams({
    action: 'TEMPLATE', text: details.title,
    dates: `${timestamp(details.start)}/${timestamp(details.end)}`,
    ctz: calendarTimeZone(timeZone), location: details.location, details: details.description,
  }).toString()
  return url.href
}

function text(value: string) {
  return value.replace(/[\uD800-\uDFFF]/gu, '\uFFFD').replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/[,;]/g, '\\$&')
}

function timestamp(date: Date) {
  return date.toISOString().replace(/[-:]|\.\d{3}/g, '')
}

function fold(line: string) {
  let bytes = 0
  let output = ''
  for (const character of line) {
    const size = encoder.encode(character).length
    if (bytes + size > 75) {
      output += '\r\n '
      bytes = 1
    }
    output += character
    bytes += size
  }
  return output
}

export function canDownloadCalendar(
  session: Pick<RallySession, 'status' | 'hostId'>,
  userId: string,
  response?: RSVPStatus,
): boolean {
  return Boolean(userId) && session.status === 'open' && (session.hostId === userId || response === 'going')
}

export function buildCalendarEvent(
  session: CalendarSession,
  invitation: string,
  now = new Date(),
  options: { sequence?: number; method?: 'PUBLISH' | 'CANCEL' } = {},
): string | null {
  const details = calendarDetails(session, invitation)
  if (!details) return null
  const { start, end, description } = details
  const cancellation = options.method === 'CANCEL'
  if (session.status !== (cancellation ? 'cancelled' : 'open')) return null
  const sequence = options.sequence ?? session.scheduleRevision ?? 0
  if (!Number.isSafeInteger(sequence) || sequence < 0 || !Number.isFinite(now.getTime()) || !Number.isFinite(start.getTime()) ||
      !Number.isFinite(end.getTime()) || end <= start) return null

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//RallyCircle//Tennis Sessions//EN',
    ...(cancellation ? ['METHOD:CANCEL'] : []),
    'BEGIN:VEVENT',
    `UID:${text(invitation)}`,
    `DTSTAMP:${timestamp(now)}`,
    `DTSTART:${timestamp(start)}`,
    `DTEND:${timestamp(end)}`,
    ...(sequence > 0 ? [`SEQUENCE:${sequence}`] : []),
    ...(cancellation ? ['STATUS:CANCELLED'] : []),
    `SUMMARY:${text(session.title)}`,
    `LOCATION:${text(details.location)}`,
    `DESCRIPTION:${text(description)}`,
    `URL:${details.invitation}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].map(fold).join('\r\n')
}
