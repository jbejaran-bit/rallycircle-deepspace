import type { RallySession } from './rally'

const encoder = new TextEncoder()

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

export interface CalendarEventOptions {
  /** RFC 5545 SEQUENCE: increments when the session time changes. Omit (or 0) for the initial export. */
  sequence?: number
  /** 'PUBLISH' (default) or 'CANCEL' for a cancelled session. */
  method?: 'PUBLISH' | 'CANCEL'
}

export function buildCalendarEvent(
  session: Pick<RallySession, 'status' | 'startsAt' | 'durationMinutes' | 'title' | 'court' | 'location'> & { scheduleRevision?: number },
  invitation: string,
  now = new Date(),
  options: CalendarEventOptions = {},
): string | null {
  const start = new Date(session.startsAt)
  const end = new Date(start.getTime() + session.durationMinutes * 60_000)
  const method = options.method ?? 'PUBLISH'
  // A cancellation is the one export allowed for a cancelled session; a
  // plain export for one still returns null, as before.
  if (method === 'CANCEL' ? session.status !== 'cancelled' : session.status !== 'open') return null
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return null
  const sequence = options.sequence ?? session.scheduleRevision ?? 0

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//RallyCircle//Tennis Sessions//EN',
    ...(method === 'CANCEL' ? ['METHOD:CANCEL'] : []),
    'BEGIN:VEVENT',
    `UID:${text(invitation)}`,
    `DTSTAMP:${timestamp(now)}`,
    `DTSTART:${timestamp(start)}`,
    `DTEND:${timestamp(end)}`,
    ...(sequence > 0 ? [`SEQUENCE:${sequence}`] : []),
    ...(method === 'CANCEL' ? ['STATUS:CANCELLED'] : []),
    `SUMMARY:${text(session.title)}`,
    `LOCATION:${text(`${session.court}, ${session.location}`)}`,
    `URL:${invitation}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].map(fold).join('\r\n')
}
