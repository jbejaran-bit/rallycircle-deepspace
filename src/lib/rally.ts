export type Level = 'All levels' | 'Beginner' | 'Intermediate' | 'Advanced'
export type RSVPStatus = 'going' | 'maybe'
export type CapacityMode = 'open' | 'limited'

export interface RallySession {
  title: string
  court: string
  location: string
  startsAt: string
  durationMinutes: number
  targetPlayers: number
  level: Level
  notes: string
  hostId: string
  chatChannelId: string
  status: 'open' | 'cancelled'
  // Optional: absent on sessions created before capacity mode existed.
  // Read as open participation with no cap (see resolveCapacity).
  capacityMode?: CapacityMode
  maxPlayers?: number
}

export interface RallyRSVP {
  sessionId: string
  userId: string
  status: RSVPStatus
}

export interface RallyWaitlist {
  sessionId: string
  userId: string
}

/**
 * Resolve a session's effective capacity. A malformed stored value is
 * treated as open participation, not clamped to a cap the host never set:
 * host session edits go through a direct record write with no server-side
 * range validation, so maxPlayers can hold any number. The UI only ever
 * offers 2–12.
 */
export function resolveCapacity(session: Pick<RallySession, 'capacityMode' | 'maxPlayers'>): { limited: boolean; maxPlayers: number } {
  if (session.capacityMode !== 'limited') return { limited: false, maxPlayers: 0 }
  const max = typeof session.maxPlayers === 'number' ? Math.floor(session.maxPlayers) : 0
  if (!Number.isFinite(max) || max < 2 || max > 12) return { limited: false, maxPlayers: 0 }
  return { limited: true, maxPlayers: max }
}

export interface WaitlistRow {
  recordId: string
  createdAt: string
  data: RallyWaitlist
}

/** Sort waitlist rows FIFO: earliest created first, recordId breaks ties. */
export function sortWaitlistRows(rows: WaitlistRow[]): WaitlistRow[] {
  return [...rows].sort((a, b) =>
    a.createdAt === b.createdAt
      ? (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0)
      : (a.createdAt < b.createdAt ? -1 : 1),
  )
}

/** 1-based FIFO position of a user on a session's waitlist; 0 when not listed. */
export function waitlistPosition(rows: WaitlistRow[], sessionId: string, userId: string): number {
  const ordered = sortWaitlistRows(rows.filter(r => r.data.sessionId === sessionId))
  const index = ordered.findIndex(r => r.data.userId === userId)
  return index === -1 ? 0 : index + 1
}

/** Validate the input BEFORE sending a write. Server schema still enforces ownership and uniqueness. */
export function validateSession(input: Omit<RallySession, 'hostId' | 'chatChannelId' | 'status'>, now = Date.now()): string | null {
  if (!input.title.trim() || input.title.trim().length > 72) return 'Use a title between 1 and 72 characters.'
  if (!input.court.trim() || input.court.trim().length > 100) return 'Enter a court name (up to 100 characters).'
  if (!input.location.trim() || input.location.trim().length > 100) return 'Enter a location (up to 100 characters).'
  const time = Date.parse(input.startsAt)
  if (!Number.isFinite(time) || time <= now) return 'Choose a future date and time.'
  if (![60, 90, 120, 150].includes(input.durationMinutes)) return 'Select a valid session duration.'
  if (!Number.isInteger(input.targetPlayers) || input.targetPlayers < 2 || input.targetPlayers > 12) return 'Choose 2–12 target players.'
  if (input.capacityMode !== undefined && input.capacityMode !== 'open' && input.capacityMode !== 'limited') return 'Choose open or limited participation.'
  if (input.capacityMode === 'limited' && (!Number.isInteger(input.maxPlayers) || (input.maxPlayers as number) < 2 || (input.maxPlayers as number) > 12)) return 'Choose 2–12 maximum players for a limited session.'
  if (!['All levels', 'Beginner', 'Intermediate', 'Advanced'].includes(input.level)) return 'Select a skill level.'
  if (input.notes.length > 400) return 'Keep notes under 400 characters.'
  return null
}

export function summarizeAttendance(rsvps: RallyRSVP[], sessionId: string) {
  const people = rsvps.filter(r => r.sessionId === sessionId)
  return {
    going: people.filter(r => r.status === 'going').length,
    maybe: people.filter(r => r.status === 'maybe').length,
  }
}

export function summarizeReadiness(confirmed: number, target: number) {
  const confirmedPlayers = Number.isFinite(confirmed) ? Math.max(0, Math.floor(confirmed)) : 0
  const targetPlayers = Number.isFinite(target) ? Math.max(0, Math.floor(target)) : 0
  const remainingToTarget = Math.max(0, targetPlayers - confirmedPlayers)
  const remainingForDoubles = Math.max(0, 4 - confirmedPlayers)

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
    status,
    detail,
  }
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
