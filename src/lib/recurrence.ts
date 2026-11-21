/**
 * Recurring sessions — validation and bounded occurrence math.
 *
 * Pure logic only. A series is a template plus a rule; occurrences are
 * materialised as ordinary sessions by an explicit host action in the
 * command room (no background jobs, no cron). Bounds are structural:
 * at most 12 occurrences per series, weekly intervals of 1–4 weeks, and
 * generation only ever creates the remaining occurrences — never an
 * unbounded stream.
 *
 * Timezone honesty: occurrences are fixed 7-day UTC intervals from the
 * first start instant. The app collects no IANA timezone from the host,
 * so a weekly 19:00-local series will shift wall-clock by an hour across
 * a DST transition. That is documented in DESIGN.md; fixing it properly
 * needs a stored timezone per series.
 */

import { validateSession, type Level, type RallySession, type SessionFormat } from './rally.js'

export const SERIES_MIN_COUNT = 2
export const SERIES_MAX_COUNT = 12
export const SERIES_MIN_INTERVAL_WEEKS = 1
export const SERIES_MAX_INTERVAL_WEEKS = 4

export interface SeriesTemplate {
  format?: SessionFormat
  title: string
  court: string
  location: string
  durationMinutes: number
  targetPlayers: number
  capacity?: number
  level: Level
  notes: string
}

export interface SeriesInput {
  template: SeriesTemplate
  startStartsAt: string
  intervalWeeks: number
  count: number
}

const DAY_MS = 86_400_000

/** Validate a series the way a session is validated, plus the series bounds. */
export function validateSeries(input: SeriesInput, now = Date.now()): string | null {
  const start = Date.parse(input.startStartsAt)
  if (!Number.isFinite(start) || start <= now) return 'Choose a future start time.'
  const candidate: Omit<RallySession, 'hostId' | 'chatChannelId' | 'status'> = {
    ...input.template,
    startsAt: new Date(start).toISOString(),
  }
  const problem = validateSession(candidate, now)
  if (problem) return problem
  if (!Number.isInteger(input.intervalWeeks) ||
      input.intervalWeeks < SERIES_MIN_INTERVAL_WEEKS ||
      input.intervalWeeks > SERIES_MAX_INTERVAL_WEEKS) {
    return `Repeat every ${SERIES_MIN_INTERVAL_WEEKS}–${SERIES_MAX_INTERVAL_WEEKS} weeks.`
  }
  if (!Number.isInteger(input.count) || input.count < SERIES_MIN_COUNT || input.count > SERIES_MAX_COUNT) {
    return `A series has ${SERIES_MIN_COUNT}–${SERIES_MAX_COUNT} occurrences.`
  }
  return null
}

/** UTC instant of occurrence `index` (0-based). Pure 7-day steps; see module header on DST. */
export function occurrenceStartsAt(startStartsAt: string, index: number, intervalWeeks: number): string {
  const start = Date.parse(startStartsAt)
  return new Date(start + index * intervalWeeks * 7 * DAY_MS).toISOString()
}

/** UTC instant of the last occurrence. */
export function seriesEndStartsAt(input: SeriesInput): string {
  return occurrenceStartsAt(input.startStartsAt, input.count - 1, input.intervalWeeks)
}

/** Parse the JSON template column of a series record. Returns null when malformed. */
export function parseSeriesTemplate(raw: string | undefined): SeriesTemplate | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const template = parsed as Record<string, unknown>
    if (typeof template.title !== 'string' || typeof template.court !== 'string' ||
        typeof template.location !== 'string' || typeof template.durationMinutes !== 'number' ||
        typeof template.targetPlayers !== 'number' || typeof template.level !== 'string' ||
        (template.notes !== undefined && typeof template.notes !== 'string')) return null
    if (template.format !== undefined && typeof template.format !== 'string') return null
    if (template.capacity !== undefined && typeof template.capacity !== 'number') return null
    // A stored template from before the notes column reads as empty notes.
    if (template.notes === undefined) template.notes = ''
    return template as unknown as SeriesTemplate
  } catch {
    return null
  }
}

export function serializeSeriesTemplate(template: SeriesTemplate): string {
  return JSON.stringify({
    format: template.format,
    title: template.title,
    court: template.court,
    location: template.location,
    durationMinutes: template.durationMinutes,
    targetPlayers: template.targetPlayers,
    capacity: template.capacity,
    level: template.level,
    notes: template.notes,
  })
}
