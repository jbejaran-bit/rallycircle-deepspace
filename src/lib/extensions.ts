/**
 * Track L — pure helpers for the safe extensions: validation, session
 * search, duplicate detection, and read-time reminders. No I/O here; the
 * server actions in src/server/extensions-actions.ts own storage and
 * authorization. Validators return an error string (same convention as
 * validateSession in rally.ts) or null when the input is valid.
 */

import { SESSION_FORMATS, type Level, type RallyRSVP, type RallySession, type SessionFormat } from './rally.js'

export const MAX_TEMPLATES_PER_USER = 20
export const MAX_FAVORITE_COURTS_PER_USER = 50
export const MAX_AVAILABILITY_WINDOWS_PER_USER = 14
export const MAX_MATCH_NOTES_PER_SESSION = 50
export const MAX_MATCH_NOTE_CHARS = 280
/** Largest record scan any extension action performs (L01/L06/L12). */
export const EXTENSION_SCAN_LIMIT = 200

export interface SessionTemplateInput {
  format: SessionFormat
  court: string
  location: string
  durationMinutes: number
  targetPlayers: number
  capacity?: number
  level: Level
  notes: string
  timeOfDay: string
}

export interface FavoriteCourtInput {
  placeId: string
  name: string
  lat: number
  lng: number
  locality: string
}

export interface AvailabilityWindowInput {
  dayOfWeek: number
  startMinutes: number
  endMinutes: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNonEmptyString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null
}

function isValidTimeOfDay(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value === '') return true
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value)
  return match !== null
}

/** Shared session-field validation (same limits as validateSession). */
function validateSessionFields(
  input: Record<string, unknown>,
): { format: SessionFormat; court: string; location: string; durationMinutes: number; targetPlayers: number; capacity?: number; level: Level; notes: string } | string {
  if (typeof input.format !== 'string' || !(SESSION_FORMATS as readonly string[]).includes(input.format)) {
    return 'Select a session format.'
  }
  const court = asNonEmptyString(input.court, 100)
  if (court === null) return 'Enter a court name (up to 100 characters).'
  const location = asNonEmptyString(input.location, 100)
  if (location === null) return 'Enter a location (up to 100 characters).'
  if (![60, 90, 120, 150].includes(input.durationMinutes as number)) return 'Select a valid session duration.'
  if (!Number.isInteger(input.targetPlayers) || (input.targetPlayers as number) < 2 || (input.targetPlayers as number) > 12) {
    return 'Choose 2–12 target players.'
  }
  let capacity: number | undefined
  if (input.capacity !== undefined && input.capacity !== null) {
    if (!Number.isInteger(input.capacity) || (input.capacity as number) < 2 || (input.capacity as number) > 12) {
      return 'Choose a capacity of 2–12 players.'
    }
    capacity = input.capacity as number
    if ((input.targetPlayers as number) > capacity) return 'The planning target cannot exceed the maximum.'
  }
  if (typeof input.level !== 'string' || !['All levels', 'Beginner', 'Intermediate', 'Advanced'].includes(input.level)) {
    return 'Select a skill level.'
  }
  if (typeof input.notes !== 'string' || input.notes.length > 400) return 'Keep notes under 400 characters.'
  return {
    format: input.format as SessionFormat,
    court,
    location,
    durationMinutes: input.durationMinutes as number,
    targetPlayers: input.targetPlayers as number,
    ...(capacity !== undefined ? { capacity } : {}),
    level: input.level as Level,
    notes: input.notes,
  }
}

export function validateSessionTemplate(input: unknown): SessionTemplateInput | string {
  if (!isRecord(input)) return 'A template must be an object.'
  const fields = validateSessionFields(input)
  if (typeof fields === 'string') return fields
  if (!isValidTimeOfDay(input.timeOfDay)) return 'Use a time of day like 19:00, or leave it blank.'
  return { ...fields, timeOfDay: (input.timeOfDay as string | undefined) ?? '' }
}

export function validateFavoriteCourt(input: unknown): FavoriteCourtInput | string {
  if (!isRecord(input)) return 'A favourite court must be an object.'
  // placeId must come from court discovery (osm:<type>/<id>); anything else
  // is rejected so private coordinates can never be smuggled in as a court.
  if (typeof input.placeId !== 'string' || !/^osm:(node|way|relation)\/\d+$/.test(input.placeId)) {
    return 'Choose a court from the court search results.'
  }
  const name = asNonEmptyString(input.name, 200)
  if (name === null) return 'Enter a court name (up to 200 characters).'
  if (typeof input.lat !== 'number' || !Number.isFinite(input.lat) || input.lat < -90 || input.lat > 90) {
    return 'Provide a valid latitude (-90 to 90).'
  }
  if (typeof input.lng !== 'number' || !Number.isFinite(input.lng) || input.lng < -180 || input.lng > 180) {
    return 'Provide a valid longitude (-180 to 180).'
  }
  const locality = typeof input.locality === 'string' ? input.locality.trim() : ''
  if (locality.length > 200) return 'Keep the locality under 200 characters.'
  return { placeId: input.placeId, name, lat: input.lat, lng: input.lng, locality }
}

export function validateAvailabilityWindow(input: unknown): AvailabilityWindowInput | string {
  if (!isRecord(input)) return 'An availability window must be an object.'
  if (!Number.isInteger(input.dayOfWeek) || (input.dayOfWeek as number) < 0 || (input.dayOfWeek as number) > 6) {
    return 'Choose a day of the week (0 = Sunday to 6 = Saturday).'
  }
  if (!Number.isInteger(input.startMinutes) || (input.startMinutes as number) < 0 || (input.startMinutes as number) > 1439) {
    return 'Choose a start time within the day.'
  }
  if (!Number.isInteger(input.endMinutes) || (input.endMinutes as number) < 1 || (input.endMinutes as number) > 1440) {
    return 'Choose an end time within the day.'
  }
  if ((input.endMinutes as number) <= (input.startMinutes as number)) return 'The end time must be after the start time.'
  return {
    dayOfWeek: input.dayOfWeek as number,
    startMinutes: input.startMinutes as number,
    endMinutes: input.endMinutes as number,
  }
}

export function validateMatchNote(input: unknown): string | null {
  if (typeof input !== 'string') return 'Write a note.'
  const trimmed = input.trim()
  if (trimmed.length === 0) return 'Write a note.'
  if (trimmed.length > MAX_MATCH_NOTE_CHARS) return `Keep match notes under ${MAX_MATCH_NOTE_CHARS} characters.`
  return null
}

export function validateChatMessageId(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  return trimmed.length > 0 && trimmed.length <= 200 ? trimmed : null
}

export function normalizePlaceName(value: string): string {
  return value.trim().toLowerCase()
}

/** Legacy format inference, mirroring find-games.ts: old sessions without a format field. */
function inferredFormat(session: RallySession): 'singles' | 'doubles' | 'practice' | 'other' {
  if (session.format === 'Singles') return 'singles'
  if (session.format === 'Doubles') return 'doubles'
  if (session.format === 'Practice') return 'practice'
  if (session.targetPlayers === 2) return 'singles'
  if (session.targetPlayers >= 4) return 'doubles'
  return 'other'
}

export interface SessionSearchFilters {
  q?: string
  format?: 'any' | 'singles' | 'doubles' | 'practice'
  level?: Level | 'Any level'
  fromDate?: string
  toDate?: string
  showCancelled?: boolean
  showPast?: boolean
  limit?: number
}

export interface SessionRecord {
  recordId: string
  data: RallySession
}

export interface SearchedSession {
  recordId: string
  title: string
  court: string
  location: string
  startsAt: string
  format: string | undefined
  level: Level
  status: 'open' | 'cancelled'
}

/**
 * L01 — bounded, deterministic session search over already-fetched records.
 * Cancelled and past sessions are excluded by default (L13: cancelled
 * sessions keep their records but never appear in discovery unless the
 * caller explicitly asks). Sorting is by start time, then recordId.
 * `truncated` is true when the scan hit EXTENSION_SCAN_LIMIT — the caller
 * must say so rather than pretend the list is complete.
 */
export function searchSessions(
  records: readonly SessionRecord[],
  filters: SessionSearchFilters,
  now = Date.now(),
): { sessions: SearchedSession[]; truncated: boolean } {
  const truncated = records.length >= EXTENSION_SCAN_LIMIT
  const query = (filters.q ?? '').trim().toLowerCase()
  const fromMs = filters.fromDate ? Date.parse(`${filters.fromDate}T00:00:00`) : undefined
  const toMs = filters.toDate ? Date.parse(`${filters.toDate}T23:59:59.999`) : undefined
  const limit = Math.min(50, Math.max(1, Math.floor(filters.limit ?? 20)))

  const matches = records.filter(({ data: session }) => {
    if (session.status === 'cancelled' && !filters.showCancelled) return false
    const startMs = Date.parse(session.startsAt)
    if (Number.isFinite(startMs) && startMs <= now && !filters.showPast) return false
    if (query && !`${session.title} ${session.court} ${session.location}`.toLowerCase().includes(query)) return false
    if (filters.format && filters.format !== 'any' && inferredFormat(session) !== filters.format) return false
    if (filters.level && filters.level !== 'Any level' && session.level !== filters.level) return false
    if (fromMs !== undefined && Number.isFinite(fromMs) && Number.isFinite(startMs) && startMs < fromMs) return false
    if (toMs !== undefined && Number.isFinite(toMs) && Number.isFinite(startMs) && startMs > toMs) return false
    return true
  })
  matches.sort((a, b) => {
    const diff = Date.parse(a.data.startsAt) - Date.parse(b.data.startsAt)
    return diff !== 0 ? diff : a.recordId < b.recordId ? -1 : 1
  })
  return {
    sessions: matches.slice(0, limit).map(({ recordId, data: session }) => ({
      recordId,
      title: session.title,
      court: session.court,
      location: session.location,
      startsAt: session.startsAt,
      format: session.format,
      level: session.level,
      status: session.status,
    })),
    truncated,
  }
}

/**
 * L12 — advisory duplicate detection. A session counts as a duplicate when
 * the same host already has an open session at the same court + location
 * starting within 5 minutes. Advisory only: session creation is a direct
 * client write, so the server cannot block it — the client shows the
 * warning and the host may still proceed explicitly.
 */
export function findDuplicateSession(
  records: readonly SessionRecord[],
  hostId: string,
  candidate: { court: string; location: string; startsAt: string },
): { recordId: string; title: string } | null {
  const startMs = Date.parse(candidate.startsAt)
  if (!Number.isFinite(startMs)) return null
  const court = normalizePlaceName(candidate.court)
  const location = normalizePlaceName(candidate.location)
  const candidates = records
    .filter(({ data: session }) =>
      session.hostId === hostId &&
      session.status === 'open' &&
      normalizePlaceName(session.court) === court &&
      normalizePlaceName(session.location) === location &&
      Math.abs(Date.parse(session.startsAt) - startMs) <= 5 * 60 * 1000,
    )
    .sort((a, b) => Date.parse(a.data.startsAt) - Date.parse(b.data.startsAt))
  const first = candidates[0]
  return first ? { recordId: first.recordId, title: first.data.title } : null
}

export interface UpcomingReminder {
  sessionId: string
  title: string
  court: string
  location: string
  startsAt: string
  minutesUntilStart: number
}

/**
 * L05 — reminders computed at read time from live session + RSVP data.
 * No records are created, no cron or timer exists. A session qualifies
 * when the caller RSVP'd `going`, it is still open, and it starts within
 * the next 24 hours.
 */
export function upcomingReminders(
  sessions: readonly SessionRecord[],
  rsvps: readonly RallyRSVP[],
  userId: string,
  now = Date.now(),
): UpcomingReminder[] {
  const going = new Set(rsvps.filter(r => r.userId === userId && r.status === 'going').map(r => r.sessionId))
  const reminders: UpcomingReminder[] = []
  for (const { recordId, data: session } of sessions) {
    if (!going.has(recordId) || session.status !== 'open') continue
    const startMs = Date.parse(session.startsAt)
    if (!Number.isFinite(startMs) || startMs <= now || startMs > now + 24 * 60 * 60 * 1000) continue
    reminders.push({
      sessionId: recordId,
      title: session.title,
      court: session.court,
      location: session.location,
      startsAt: session.startsAt,
      minutesUntilStart: Math.floor((startMs - now) / 60_000),
    })
  }
  reminders.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
  return reminders
}
