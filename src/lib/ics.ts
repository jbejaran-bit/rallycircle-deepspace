/**
 * RFC 5545 (.ics) export for a RallyCircle session. Pure functions only:
 * no network, no OAuth, no Google Calendar — the file is generated in the
 * browser and downloaded by the user.
 *
 * Timezone approach (deliberate, documented):
 * A session stores exactly one timestamp, `startsAt`, as an ISO-8601 UTC
 * string, plus a duration in minutes. No IANA timezone is stored (the
 * create form takes a `datetime-local` value and converts it to UTC at
 * submit time), so there is no local-time zone to put in a VTIMEZONE
 * component — fabricating one would be wrong. The export therefore emits
 * DTSTART/DTEND in UTC (`...Z`) form. UTC is absolute, so daylight saving
 * transitions cannot shift the event: a session at 2026-11-01T06:30:00Z is
 * 01:30 EST (after the US fall-back), and the same instant rendered by a
 * calendar client in the viewer's local zone is always the same instant.
 * The honest limit: the file cannot preserve "the wall-clock time the host
 * typed" across a DST rule change, because that information was already
 * discarded when the form converted to UTC. If a timezone is ever stored
 * on the session, add a VTIMEZONE and TZID form then.
 */
import type { RallySession } from './rally'

export interface IcsEventInput {
  sessionId: string
  session: RallySession
  origin: string
  goingCount?: number
}

const CRLF = '\r\n'

/** RFC 5545 section 3.3.11 TEXT escaping: backslash, comma, semicolon, newline. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

/**
 * Fold a logical line at 75 octets (RFC 5545 section 3.1); continuation
 * lines start with a space. Folding is by octets, not characters, and never
 * splits a UTF-8 multi-byte sequence.
 */
export function foldIcsLine(line: string): string {
  const bytes = new TextEncoder().encode(line)
  if (bytes.length <= 75) return line
  const chunks: string[] = []
  let start = 0
  let first = true
  while (start < bytes.length) {
    const limit = first ? 75 : 74 // continuation line reserves 1 octet for the leading space
    let end = Math.min(start + limit, bytes.length)
    // Never split a UTF-8 multi-byte sequence: back off past continuation bytes.
    while (end > start && (bytes[end] & 0xc0) === 0x80) end--
    if (end === start) end = start + 1 // unreachable for valid UTF-8; guards against an infinite loop
    chunks.push(new TextDecoder().decode(bytes.subarray(start, end)))
    start = end
    first = false
  }
  return chunks.join(`${CRLF} `)
}

/** Format a Date as a UTC timestamp, e.g. 20261101T063000Z. */
export function formatIcsUtc(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
}

/**
 * Build the .ics document for one session, or null when the session has no
 * usable start time or duration. UID is deterministic (session id), so
 * re-downloading and re-importing the same session updates rather than
 * duplicating the event in most calendar clients.
 */
export function buildSessionIcs(input: IcsEventInput): string | null {
  const start = new Date(input.session.startsAt)
  if (Number.isNaN(start.getTime())) return null
  if (!Number.isFinite(input.session.durationMinutes) || input.session.durationMinutes <= 0) return null
  const end = new Date(start.getTime() + input.session.durationMinutes * 60_000)
  const url = `${input.origin.replace(/\/$/, '')}/rallies?session=${encodeURIComponent(input.sessionId)}`
  const descriptionParts = [
    `Level: ${input.session.level}`,
    `Duration: ${input.session.durationMinutes} minutes`,
    ...(input.goingCount !== undefined ? [`${input.goingCount} going`] : []),
    ...(input.session.notes ? [input.session.notes] : []),
    `Session link: ${url}`,
  ]
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//RallyCircle//Session Export//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${input.sessionId}@rallycircle`,
    `DTSTAMP:${formatIcsUtc(new Date())}`,
    `DTSTART:${formatIcsUtc(start)}`,
    `DTEND:${formatIcsUtc(end)}`,
    `SUMMARY:${escapeIcsText(input.session.title)}`,
    `LOCATION:${escapeIcsText(`${input.session.court}, ${input.session.location}`)}`,
    `DESCRIPTION:${escapeIcsText(descriptionParts.join('\n'))}`,
    `URL:${url}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return lines.map(foldIcsLine).join(CRLF) + CRLF
}

/** Safe download filename for a session id. */
export function sessionIcsFilename(sessionId: string): string {
  return `rallycircle-${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.ics`
}

/** Trigger a browser download of the generated file. Returns false when generation failed. */
export function downloadSessionIcs(input: IcsEventInput): boolean {
  const ics = buildSessionIcs(input)
  if (!ics) return false
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' })
  const href = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = sessionIcsFilename(input.sessionId)
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(href)
  return true
}
