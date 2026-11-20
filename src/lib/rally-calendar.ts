import type { RallySession, RSVPStatus } from './rally'

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

export function canDownloadCalendar(
  session: Pick<RallySession, 'status' | 'hostId'>,
  userId: string,
  response?: RSVPStatus,
): boolean {
  return Boolean(userId) && session.status === 'open' && (session.hostId === userId || response === 'going')
}

export function buildCalendarEvent(
  session: Pick<RallySession, 'status' | 'startsAt' | 'durationMinutes' | 'title' | 'court' | 'location'> & Partial<Pick<RallySession, 'format' | 'level' | 'scheduleRevision'>>,
  invitation: string,
  now = new Date(),
  options: { sequence?: number; method?: 'PUBLISH' | 'CANCEL' } = {},
): string | null {
  const url = URL.parse(invitation)
  if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || /[\r\n]/.test(invitation)) return null
  const description = [
    session.format && `Format: ${session.format}`,
    session.level && `Level: ${session.level}`,
    `View rally: ${invitation}`,
  ].filter(Boolean).join('\n')
  const start = new Date(session.startsAt)
  const end = new Date(start.getTime() + session.durationMinutes * 60_000)
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
    `LOCATION:${text(`${session.court}, ${session.location}`)}`,
    `DESCRIPTION:${text(description)}`,
    `URL:${url.href}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].map(fold).join('\r\n')
}
