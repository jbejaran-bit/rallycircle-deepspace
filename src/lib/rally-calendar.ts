import type { RallySession } from './rally'

const encoder = new TextEncoder()

function text(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/[,;]/g, '\\$&')
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

export function buildCalendarEvent(
  session: Pick<RallySession, 'status' | 'startsAt' | 'durationMinutes' | 'title' | 'court' | 'location'>,
  invitation: string,
  now = new Date(),
): string | null {
  const start = new Date(session.startsAt)
  const end = new Date(start.getTime() + session.durationMinutes * 60_000)
  if (session.status !== 'open' || !Number.isFinite(start.getTime()) ||
      !Number.isFinite(end.getTime()) || end <= start) return null

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//RallyCircle//Tennis Sessions//EN',
    'BEGIN:VEVENT',
    `UID:${text(invitation)}`,
    `DTSTAMP:${timestamp(now)}`,
    `DTSTART:${timestamp(start)}`,
    `DTEND:${timestamp(end)}`,
    `SUMMARY:${text(session.title)}`,
    `LOCATION:${text(`${session.court}, ${session.location}`)}`,
    `URL:${invitation}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].map(fold).join('\r\n')
}
