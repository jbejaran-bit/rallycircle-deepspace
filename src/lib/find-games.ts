/**
 * Find Games Near Me — pure filtering over live session records.
 *
 * Design choice (documented, deliberate): this is a small-scale filtered
 * experience over the records the client already syncs (`useQuery`), not a
 * dedicated geographic index. That matches the current scale (tens of
 * sessions, not thousands) and avoids a new backend service. If session
 * volume grows, the filter inputs here (area/level/format/date/distance)
 * map 1:1 onto a future server-side query — the page would only swap its
 * data source.
 *
 * Privacy: no participant location is ever used. Distances are computed
 * from the *viewer's* one-shot location (kept in page state, never stored)
 * against *public court/session locations* only. A session whose court has
 * no known coordinates simply has no distance; it is never geocoded, and
 * no coordinates are fabricated for it.
 *
 * Capacity: the 8fd8c2c base has no capacity mode — `targetPlayers` is a
 * planning goal, not a cap. So there is no invented "full" state here:
 * a session is "target reached" when going >= target, and it stays joinable.
 * If a capacity mode lands later, add a `capacity` field to the annotation
 * and a `full` status; the filter shape does not need to change.
 */

import { haversineMiles, matchesArea, normalizePlaceName, type LatLng } from './geo.ts'
import type { Level, RallyRSVP, RallySession } from './rally'

export type GameFormat = 'any' | 'singles' | 'doubles'
export type GameStatus = 'needs-players' | 'target-reached'

export interface GameFilters {
  /** Free-text area/court substring; empty means no area filter. */
  area?: string
  level?: Level | 'Any level'
  format?: GameFormat
  /** Inclusive ISO date bounds (`YYYY-MM-DD`); empty means unbounded. */
  fromDate?: string
  toDate?: string
  /** Only sessions whose court has known coordinates and is within this distance (miles). */
  maxDistanceMiles?: number
  /** Default false: hide cancelled sessions. */
  showCancelled?: boolean
  /** Default false: hide sessions that already started. */
  showPast?: boolean
}

export interface KnownCourtLocation {
  /** Court name as it appears in session records (matching is normalised). */
  name: string
  lat: number
  lng: number
}

export interface AnnotatedGame {
  recordId: string
  session: RallySession
  going: number
  maybe: number
  status: GameStatus
  cancelled: boolean
  past: boolean
  /** Straight-line miles from the viewer, or null when the court has no known coordinates. */
  distanceMiles: number | null
  isMine: boolean
}

export const DEFAULT_GAME_RADIUS_MILES = 10

/** Tokens too generic to identify a court on their own. */
const COURT_NAME_STOPWORDS = new Set(['tennis', 'court', 'courts'])

function sessionFormat(session: RallySession): 'singles' | 'doubles' | 'other' {
  if (session.targetPlayers === 2) return 'singles'
  if (session.targetPlayers >= 4) return 'doubles'
  return 'other'
}

function formatMatches(session: RallySession, format: GameFormat): boolean {
  if (format === 'any') return true
  return sessionFormat(session) === format
}

/**
 * Filter + annotate sessions. Pure function: `now` is injectable so tests
 * are deterministic. Sorting is by start time, then by distance when the
 * viewer location is known (unknown-distance sessions sort after known
 * ones at the same time).
 */
export function filterGames(
  sessions: { recordId: string; data: RallySession }[],
  rsvps: RallyRSVP[],
  filters: GameFilters,
  options: {
    now?: number
    userId?: string
    userLocation?: LatLng
    knownCourts?: KnownCourtLocation[]
  } = {},
): AnnotatedGame[] {
  const now = options.now ?? Date.now()
  const userLocation = options.userLocation

  const fromMs = filters.fromDate ? Date.parse(`${filters.fromDate}T00:00:00`) : undefined
  const toMs = filters.toDate ? Date.parse(`${filters.toDate}T23:59:59.999`) : undefined

  const annotated: AnnotatedGame[] = []
  for (const { recordId, data: session } of sessions) {
    const startMs = Date.parse(session.startsAt)
    const cancelled = session.status === 'cancelled'
    const past = Number.isFinite(startMs) && startMs <= now
    if (cancelled && !filters.showCancelled) continue
    if (past && !filters.showPast) continue
    if (filters.area && !matchesArea(`${session.court} ${session.location}`, filters.area)) continue
    if (filters.level && filters.level !== 'Any level' && session.level !== filters.level) continue
    if (!formatMatches(session, filters.format ?? 'any')) continue
    if (fromMs !== undefined && Number.isFinite(fromMs) && Number.isFinite(startMs) && startMs < fromMs) continue
    if (toMs !== undefined && Number.isFinite(toMs) && Number.isFinite(startMs) && startMs > toMs) continue

    const going = rsvps.filter(r => r.sessionId === recordId && r.status === 'going').length
    const maybe = rsvps.filter(r => r.sessionId === recordId && r.status === 'maybe').length

    // Distance only when the session's court matches a court with known
    // coordinates. Matching is by normalised name — whole-name substring
    // either way, or a shared distinctive token (e.g. "Schenley" links a
    // session at "Schenley Park" to "Schenley Oval Tennis Courts"). Generic
    // tokens such as "tennis"/"court" never match on their own.
    // Text-only locations are never geocoded.
    let distanceMiles: number | null = null
    if (userLocation) {
      const courtName = normalizePlaceName(session.court)
      const courtTokens = new Set(
        courtName.split(/[^a-z0-9]+/).filter(token => token.length >= 6 && !COURT_NAME_STOPWORDS.has(token)),
      )
      const match = (options.knownCourts ?? []).find(known => {
        const knownName = normalizePlaceName(known.name)
        if (knownName.length < 6 || courtName.length < 6) return knownName === courtName
        if (knownName.includes(courtName) || courtName.includes(knownName)) return true
        const knownTokens = knownName.split(/[^a-z0-9]+/).filter(token => token.length >= 6 && !COURT_NAME_STOPWORDS.has(token))
        return knownTokens.some(token => courtTokens.has(token))
      })
      if (match) distanceMiles = haversineMiles(userLocation, { lat: match.lat, lng: match.lng })
    }
    if (
      filters.maxDistanceMiles !== undefined &&
      (distanceMiles === null || distanceMiles > filters.maxDistanceMiles)
    ) {
      continue
    }

    annotated.push({
      recordId,
      session,
      going,
      maybe,
      status: going >= session.targetPlayers ? 'target-reached' : 'needs-players',
      cancelled,
      past,
      distanceMiles,
      isMine:
        options.userId !== undefined &&
        (session.hostId === options.userId ||
          rsvps.some(r => r.sessionId === recordId && r.userId === options.userId)),
    })
  }

  annotated.sort((a, b) => {
    const timeDiff = Date.parse(a.session.startsAt) - Date.parse(b.session.startsAt)
    if (timeDiff !== 0) return timeDiff
    if (a.distanceMiles === null && b.distanceMiles === null) return 0
    if (a.distanceMiles === null) return 1
    if (b.distanceMiles === null) return -1
    return a.distanceMiles - b.distanceMiles
  })
  return annotated
}

/** Human-readable status label for the badge. */
export function gameStatusLabel(game: AnnotatedGame): string {
  if (game.cancelled) return 'Cancelled'
  if (game.past) return 'Past session'
  return game.status === 'target-reached' ? 'Target reached' : 'Needs players'
}
