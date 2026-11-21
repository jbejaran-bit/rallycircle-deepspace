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
 * Capacity comes from the optional immutable session maximum, independently of the target.
 */

import { haversineMiles, isValidLatLng, matchesArea, normalizePlaceName, type LatLng } from './geo.ts'
import type { Level, RallyRSVP, RallySession } from './rally'

export type GameFormat = 'any' | 'singles' | 'doubles' | 'practice'
export type GameSort = 'soonest' | 'nearest'
export type GameStatus = 'needs-players' | 'target-reached' | 'full'

export interface GameFilters {
  /** Free-text area/court substring; empty means no area filter. */
  area?: string
  /** Match game title, court, or area. */
  query?: string
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
  availability?: 'any' | 'spots' | 'waitlist'
  sort?: GameSort
}

export interface KnownCourtLocation {
  /** Court name as it appears in session records (matching is normalised). */
  name: string
  locality?: string
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

function sessionFormat(session: RallySession): Exclude<GameFormat, 'any'> | 'other' {
  if (session.format === 'Singles') return 'singles'
  if (session.format === 'Doubles') return 'doubles'
  if (session.format === 'Practice') return 'practice'
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
 * are deterministic. Sort by start time by default or by nearest known
 * distance when requested and a location is available.
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
  const userLocation = isValidLatLng(options.userLocation) ? options.userLocation : undefined
  const terms = normalizePlaceName(filters.query ?? '').split(' ').filter(Boolean)

  const fromMs = filters.fromDate ? Date.parse(`${filters.fromDate}T00:00:00`) : undefined
  const toMs = filters.toDate ? Date.parse(`${filters.toDate}T23:59:59.999`) : undefined

  const attendance = new Map<string, { going: number; maybe: number; isMine: boolean }>()
  const countedMembers = new Set<string>()
  for (const rsvp of rsvps) {
    // Legacy/partially synced records can contain duplicate membership rows or
    // unexpected statuses. Neither should inflate capacity or produce NaN.
    if (rsvp.status !== 'going' && rsvp.status !== 'maybe') continue
    if (typeof rsvp.sessionId !== 'string' || typeof rsvp.userId !== 'string' || !rsvp.userId) continue
    const memberKey = JSON.stringify([rsvp.sessionId, rsvp.userId])
    if (countedMembers.has(memberKey)) continue
    countedMembers.add(memberKey)
    const existing = attendance.get(rsvp.sessionId) ?? { going: 0, maybe: 0, isMine: false }
    existing[rsvp.status]++
    existing.isMine ||= options.userId !== undefined && rsvp.userId === options.userId
    attendance.set(rsvp.sessionId, existing)
  }
  const annotated: AnnotatedGame[] = []
  for (const { recordId, data: session } of sessions) {
    const startMs = Date.parse(session.startsAt)
    if (!Number.isFinite(startMs)) continue
    const cancelled = session.status === 'cancelled'
    const past = startMs <= now
    if (cancelled && !filters.showCancelled) continue
    if (past && !filters.showPast) continue
    if (terms.length) {
      const text = normalizePlaceName(`${session.title} ${session.court} ${session.location}`)
      if (!terms.every(term => text.includes(term))) continue
    }
    if (filters.area && !matchesArea(`${session.court} ${session.location}`, filters.area)) continue
    if (filters.level && filters.level !== 'Any level' && session.level !== filters.level) continue
    if (!formatMatches(session, filters.format ?? 'any')) continue
    if (fromMs !== undefined && Number.isFinite(fromMs) && Number.isFinite(startMs) && startMs < fromMs) continue
    if (toMs !== undefined && Number.isFinite(toMs) && Number.isFinite(startMs) && startMs > toMs) continue

    const { going, maybe, isMine } = attendance.get(recordId) ?? { going: 0, maybe: 0, isMine: false }

    const full = session.capacity != null && going >= session.capacity
    if (filters.availability === 'spots' && (full || cancelled || past)) continue
    if (filters.availability === 'waitlist' && (!full || cancelled || past)) continue

    // Keep distance unknown when a court name is ambiguous. Use locality
    // when available, and never geocode a user's free-text session fields.
    let distanceMiles: number | null = null
    if (userLocation) {
      const courtName = normalizePlaceName(session.court)
      const courtTokens = new Set(
        courtName.split(/[^a-z0-9]+/).filter(token => token.length >= 6 && !COURT_NAME_STOPWORDS.has(token)),
      )
      const area = normalizePlaceName(session.location)
      const candidates = (options.knownCourts ?? []).filter(known => {
        if (!isValidLatLng(known)) return false
        const locality = known.locality && normalizePlaceName(known.locality)
        if (locality && (!area || (!area.includes(locality) && !locality.includes(area)))) return false
        const knownName = normalizePlaceName(known.name)
        if (knownName.length < 6 || courtName.length < 6) return knownName === courtName
        if (knownName.includes(courtName) || courtName.includes(knownName)) return true
        const knownTokens = knownName.split(/[^a-z0-9]+/).filter(token => token.length >= 6 && !COURT_NAME_STOPWORDS.has(token))
        return knownTokens.some(token => courtTokens.has(token))
      })
      const exact = candidates.filter(known => normalizePlaceName(known.name) === courtName)
      const matches = exact.length ? exact : candidates
      const [match] = matches
      if (match && matches.every(court => court.lat === match.lat && court.lng === match.lng)) {
        distanceMiles = haversineMiles(userLocation, { lat: match.lat, lng: match.lng })
      }
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
      status: full ? 'full' : going >= session.targetPlayers ? 'target-reached' : 'needs-players',
      cancelled,
      past,
      distanceMiles,
      isMine:
        options.userId !== undefined &&
        (session.hostId === options.userId ||
          isMine),
    })
  }

  annotated.sort((a, b) => {
    const timeDiff = Date.parse(a.session.startsAt) - Date.parse(b.session.startsAt)
    const distanceDiff = a.distanceMiles === b.distanceMiles ? 0 : (a.distanceMiles ?? Infinity) - (b.distanceMiles ?? Infinity)
    return filters.sort === 'nearest' && userLocation ? distanceDiff || timeDiff : timeDiff || distanceDiff
  })
  return annotated
}

/** Human-readable status label for the badge. */
export function gameStatusLabel(game: AnnotatedGame): string {
  if (game.cancelled) return 'Cancelled'
  if (game.past) return 'Past session'
  if (game.status === 'full') return 'Full · waitlist available'
  return game.status === 'target-reached' ? 'Target reached' : 'Needs players'
}

export type DiscoveryAction = 'rsvp' | 'joinWaitlist'

export function discoveryAction(
  game: Pick<AnnotatedGame, 'cancelled' | 'past' | 'status' | 'session'>,
  userId: string | null | undefined,
  going: boolean,
  waiting: boolean,
): DiscoveryAction | null {
  if (!userId || game.cancelled || game.past || game.session.hostId === userId || going || waiting) return null
  return game.status === 'full' ? 'joinWaitlist' : 'rsvp'
}
