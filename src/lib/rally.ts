export type Level = 'All levels' | 'Beginner' | 'Intermediate' | 'Advanced'
export const SESSION_FORMATS = ['Singles', 'Doubles', 'Practice'] as const
export type SessionFormat = typeof SESSION_FORMATS[number]

export type RSVPStatus = 'going' | 'maybe'

export interface RallySession {
  format?: SessionFormat
  matchScore?: string
  pendingResult?: string
  seriesId?: string
  scheduleRevision?: number
  title: string
  court: string
  location: string
  startsAt: string
  durationMinutes: number
  targetPlayers: number
  capacity?: number
  level: Level
  notes: string
  hostId: string
  chatChannelId: string
  status: 'open' | 'cancelled'
}

export interface RallyWaitlist {
  sessionId: string
  userId: string
}

export interface RallyRSVP {
  sessionId: string
  userId: string
  status: RSVPStatus
}

/** Validate the input BEFORE sending a write. Server schema still enforces ownership and uniqueness. */
export function validateSession(input: Omit<RallySession, 'hostId' | 'chatChannelId' | 'status'>, now = Date.now()): string | null {
  if (input.format !== undefined && !SESSION_FORMATS.includes(input.format)) return 'Select a session format.'
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 72) return 'Use a title between 1 and 72 characters.'
  if (typeof input.court !== 'string' || !input.court.trim() || input.court.trim().length > 100) return 'Enter a court name (up to 100 characters).'
  if (typeof input.location !== 'string' || !input.location.trim() || input.location.trim().length > 100) return 'Enter a location (up to 100 characters).'
  const time = Date.parse(input.startsAt)
  if (!Number.isFinite(time) || time <= now) return 'Choose a future date and time.'
  if (![60, 90, 120, 150].includes(input.durationMinutes)) return 'Select a valid session duration.'
  if (input.capacity != null && !validCapacity(input.capacity)) return 'Choose a capacity of 2–12 players.'
  if (!Number.isInteger(input.targetPlayers) || input.targetPlayers < 2 || input.targetPlayers > 12) return 'Choose 2–12 target players.'
  if (input.capacity != null && input.targetPlayers > input.capacity) return 'The planning target cannot exceed the maximum.'
  if (!['All levels', 'Beginner', 'Intermediate', 'Advanced'].includes(input.level)) return 'Select a skill level.'
  // F7 (user decision, 2026-11-21): missing or null notes read as '' —
  // stored pre-field templates predate the column. A present but
  // non-string value is malformed and rejected, never coerced.
  if (input.notes != null && typeof input.notes !== 'string') return 'Notes must be text.'
  if ((input.notes ?? '').length > 400) return 'Keep notes under 400 characters.'
  return null
}

export function validCapacity(value: number): boolean {
  return Number.isInteger(value) && value >= 2 && value <= 12
}

/** Index record envelopes without losing the record IDs used for withdrawal. */
export function groupSessionRsvps<T extends { data: RallyRSVP }>(records: readonly T[]): Map<string, T[]> {
  const bySession = new Map<string, T[]>()
  for (const record of records) {
    const sessionId = record.data.sessionId
    const group = bySession.get(sessionId)
    if (group) group.push(record)
    else bySession.set(sessionId, [record])
  }
  return bySession
}

export function summarizeAttendance(rsvps: RallyRSVP[], sessionId: string) {
  const people = rsvps.filter(r => r.sessionId === sessionId)
  return {
    going: people.filter(r => r.status === 'going').length,
    maybe: people.filter(r => r.status === 'maybe').length,
  }
}

export function summarizeReadiness(confirmed: number, target: number, format?: SessionFormat) {
  const confirmedPlayers = Number.isFinite(confirmed) ? Math.max(0, Math.floor(confirmed)) : 0
  const targetPlayers = Number.isFinite(target) ? Math.max(0, Math.floor(target)) : 0
  const remainingToTarget = Math.max(0, targetPlayers - confirmedPlayers)
  const remainingForDoubles = Math.max(0, 4 - confirmedPlayers)

  if (format === 'Singles' || format === 'Practice') {
    const minimum = format === 'Singles' ? 2 : targetPlayers
    const ready = confirmedPlayers >= minimum
    const remaining = remainingToTarget || Math.max(0, minimum - confirmedPlayers)
    return {
      confirmedPlayers, targetPlayers, remainingToTarget, remainingForDoubles, ready,
      status: ready
        ? (format === 'Singles' ? 'Singles ready!' : 'Target reached')
        : remaining === 1 ? 'One more player needed' : `${remaining} more players needed`,
      detail: ready && remainingToTarget > 0
        ? `${remainingToTarget} more ${remainingToTarget === 1 ? 'player' : 'players'} to reach your target.`
        : '',
    }
  }

  let status: string
  if (remainingForDoubles === 0) {
    status = 'Doubles ready!'
  } else if (remainingToTarget === 1) {
    status = 'One more player needed'
  } else if (remainingToTarget > 1) {
    status = `${remainingToTarget} more players needed`
  } else {
    status = `${remainingForDoubles} more ${remainingForDoubles === 1 ? 'player' : 'players'} needed for doubles`
  }

  let detail = ''
  if (remainingForDoubles > 0 && remainingToTarget > 0 && remainingToTarget !== remainingForDoubles) {
    detail = `${remainingForDoubles === 1 ? 'One more player' : `${remainingForDoubles} more players`} to make doubles.`
  } else if (remainingForDoubles === 0 && remainingToTarget > 0) {
    detail = `${remainingToTarget} more ${remainingToTarget === 1 ? 'player' : 'players'} to reach your target.`
  } else if (remainingForDoubles === 0) {
    detail = 'Your target is reached. Extra players can still join.'
  }

  return {
    confirmedPlayers,
    targetPlayers,
    remainingToTarget,
    remainingForDoubles,
    ready: remainingForDoubles === 0,
    status,
    detail,
  }
}

/** Resolve the browser's local date input without silently rolling invalid wall times forward. */
export function parseLocalSessionStart(value: string): Date | null {
  const selected = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!selected) return null
  const [, year, month, day, hour, minute] = selected.map(Number)
  const date = new Date(value)
  if (date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day ||
      date.getHours() !== hour || date.getMinutes() !== minute) return null
  return date
}

export function formatSessionTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Time unavailable'
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(date)
}


/** Direct link to a single session; safe for referrals and cross-account tests. */
export function buildSessionUrl(origin: string, sessionId: string): string {
  const url = new URL('/rallies', origin)
  url.searchParams.set('session', sessionId)
  return url.toString()
}
