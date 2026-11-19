export type Level = 'All levels' | 'Beginner' | 'Intermediate' | 'Advanced'
export type RSVPStatus = 'going' | 'maybe'

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
}

export interface RallyRSVP {
  sessionId: string
  userId: string
  status: RSVPStatus
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
