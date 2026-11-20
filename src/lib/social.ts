import { matchesArea } from './geo.ts'
import type { AnnotatedGame, GameFormat } from './find-games.ts'
import type { Level, RallyRSVP, RallySession } from './rally.ts'
import { readMatchScore, resultStatus } from './rally-score.ts'

// Pure social-graph, activity-feed, and discovery-ranking logic.
//
// Everything here is a pure function over record arrays: no I/O, no auth,
// no clock except an injectable `now`. The server actions in
// src/server/social-actions.ts own identity, authorization, rate limits, and
// persistence; this module owns the rules those actions apply.
//
// Privacy seams (documented, deliberate):
// - Display names do not exist in this base (no profile collection). Every
//   user is identified by their verified auth id; a profile display name,
//   when Track B lands, resolves through that id and degrades to the id.
// - Sessions in this base are public invitations to signed-in members, so a
//   "public event" is any non-cancelled session. If a private-session flag
//   is ever added, deriveActivityFeed must exclude it — see the TODO there.

export type SocialFormat = Exclude<GameFormat, 'any'>

export interface DiscoveryPreferences {
  formats: SocialFormat[]
  level: Level
  area: string
  radiusMiles: number
  /** '' means no time window; otherwise 'HH:MM' (24h). Both or neither. */
  timeStart: string
  timeEnd: string
  /** 0 = Sunday … 6 = Saturday. Empty means any day. */
  days: number[]
}

export const DEFAULT_PREFERENCES: DiscoveryPreferences = {
  formats: [],
  level: 'All levels',
  area: '',
  radiusMiles: 10,
  timeStart: '',
  timeEnd: '',
  days: [],
}

const LEVEL_ORDER: Record<Exclude<Level, 'All levels'>, number> = {
  Beginner: 0,
  Intermediate: 1,
  Advanced: 2,
}

export function validateUserId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200 && !/\s/.test(value)
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

export function validatePreferences(input: unknown): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return 'Preferences must be an object.'
  const prefs = input as Partial<DiscoveryPreferences>
  if (!Array.isArray(prefs.formats) || prefs.formats.length > 3) return 'Choose up to three formats.'
  if (prefs.formats.some(f => f !== 'singles' && f !== 'doubles' && f !== 'practice')) return 'Choose a supported format.'
  if (new Set(prefs.formats).size !== prefs.formats.length) return 'Formats must not repeat.'
  if (prefs.level !== 'All levels' && prefs.level !== 'Beginner' && prefs.level !== 'Intermediate' && prefs.level !== 'Advanced') {
    return 'Select a skill level.'
  }
  if (typeof prefs.area !== 'string' || prefs.area.length > 100) return 'Area must be at most 100 characters.'
  const radius = prefs.radiusMiles
  if (typeof radius !== 'number' || !Number.isInteger(radius) || radius < 1 || radius > 100) {
    return 'Choose a search radius of 1–100 miles.'
  }
  if (typeof prefs.timeStart !== 'string' || typeof prefs.timeEnd !== 'string') return 'Time windows must be text.'
  const hasStart = prefs.timeStart !== ''
  const hasEnd = prefs.timeEnd !== ''
  if (hasStart !== hasEnd) return 'Set both a start and an end time, or neither.'
  if (hasStart && (!TIME_RE.test(prefs.timeStart) || !TIME_RE.test(prefs.timeEnd))) return 'Use 24-hour HH:MM times.'
  if (hasStart && prefs.timeStart >= prefs.timeEnd) return 'A time window must end after it starts (no overnight windows yet).'
  if (!Array.isArray(prefs.days) || prefs.days.length > 7) return 'Choose up to seven days.'
  if (prefs.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) return 'Days must be 0 (Sunday) to 6 (Saturday).'
  if (new Set(prefs.days).size !== prefs.days.length) return 'Days must not repeat.'
  return null
}

/** Decode a stored discoveryPreferences record (JSON text columns). Invalid stored data falls back to defaults for that field. */
export function decodePreferences(data: Record<string, unknown>): DiscoveryPreferences {
  const fallback = { ...DEFAULT_PREFERENCES, formats: [] as SocialFormat[], days: [] as number[] }
  const parsed = (raw: unknown): unknown => {
    if (typeof raw !== 'string') return undefined
    try {
      return JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  const formats = parsed(data.formats)
  const days = parsed(data.days)
  const candidate: DiscoveryPreferences = {
    formats: Array.isArray(formats) ? (formats as SocialFormat[]) : [],
    level: typeof data.level === 'string' ? (data.level as Level) : 'All levels',
    area: typeof data.area === 'string' ? data.area : '',
    radiusMiles: typeof data.radiusMiles === 'number' ? data.radiusMiles : 10,
    timeStart: typeof data.timeStart === 'string' ? data.timeStart : '',
    timeEnd: typeof data.timeEnd === 'string' ? data.timeEnd : '',
    days: Array.isArray(days) ? (days as number[]) : [],
  }
  return validatePreferences(candidate) === null ? candidate : fallback
}

export function encodePreferences(prefs: DiscoveryPreferences): Record<string, unknown> {
  return {
    formats: JSON.stringify(prefs.formats),
    level: prefs.level,
    area: prefs.area,
    radiusMiles: prefs.radiusMiles,
    timeStart: prefs.timeStart,
    timeEnd: prefs.timeEnd,
    days: JSON.stringify(prefs.days),
  }
}

// ---------------------------------------------------------------------------
// Cursor pagination over createdAt (SDK queries have no cursor/offset).
//
// Queries are bounded (at most PAGE_WINDOW records, newest first) and the
// cursor is the createdAt of the last returned record. Callers pass that
// cursor back as `before`; older records are filtered in code. This keeps
// every list bounded while remaining deterministic.
// ---------------------------------------------------------------------------

export const LIST_PAGE_WINDOW = 200
export const DEFAULT_LIST_LIMIT = 20
export const MAX_LIST_LIMIT = 50

export function clampListLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_LIST_LIMIT
  return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(limit)))
}

export function pageByCreatedAt<T extends { createdAt: string }>(
  records: readonly T[],
  limit: number,
  before?: string,
): { page: T[]; nextCursor: string | null } {
  const sorted = [...records].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  const afterCursor = before === undefined ? sorted : sorted.filter(record => record.createdAt < before)
  const page = afterCursor.slice(0, limit)
  const nextCursor = afterCursor.length > limit ? page[page.length - 1].createdAt : null
  return { page, nextCursor }
}

// ---------------------------------------------------------------------------
// Previously played with — derived from ACTUAL records only.
// ---------------------------------------------------------------------------

export interface PlayedWithEntry {
  userId: string
  /** Sessions shared (host or confirmed RSVP). */
  sharedSessions: number
  /** Finalized matches together (from matchScore teams). */
  matchesTogether: number
  matchesWonTogether: number
  matchesAgainst: number
  matchesWonAgainst: number
  lastPlayedAt: string
}

export function derivePlayedWith(
  sessions: { recordId: string; data: RallySession; createdAt: string }[],
  rsvps: RallyRSVP[],
  viewerId: string,
): PlayedWithEntry[] {
  const entries = new Map<string, PlayedWithEntry>()
  const touch = (userId: string, at: string): PlayedWithEntry => {
    const existing = entries.get(userId)
    if (existing) {
      if (at > existing.lastPlayedAt) existing.lastPlayedAt = at
      return existing
    }
    const entry: PlayedWithEntry = {
      userId,
      sharedSessions: 0,
      matchesTogether: 0,
      matchesWonTogether: 0,
      matchesAgainst: 0,
      matchesWonAgainst: 0,
      lastPlayedAt: at,
    }
    entries.set(userId, entry)
    return entry
  }

  const goingBySession = new Map<string, Set<string>>()
  for (const rsvp of rsvps) {
    if (rsvp.status !== 'going') continue
    const set = goingBySession.get(rsvp.sessionId) ?? new Set<string>()
    set.add(rsvp.userId)
    goingBySession.set(rsvp.sessionId, set)
  }

  for (const { recordId, data: session } of sessions) {
    if (session.status === 'cancelled') continue
    const players = new Set(goingBySession.get(recordId) ?? [])
    players.add(session.hostId)
    if (!players.has(viewerId)) continue
    for (const other of players) {
      if (other === viewerId) continue
      const entry = touch(other, session.startsAt)
      entry.sharedSessions += 1
    }
    // Finalized matches only: a disputed or unconfirmed result never counts.
    const score = readMatchScore(session.matchScore)
    if (score && resultStatus(score) === 'final' && score.winner !== null) {
      const teams = score.teams
      const viewerTeam = teams[0].includes(viewerId) ? 0 : teams[1].includes(viewerId) ? 1 : -1
      if (viewerTeam !== -1) {
        const viewerWon = score.winner === viewerTeam
        for (let side = 0; side < 2; side++) {
          for (const player of teams[side]) {
            if (player === viewerId) continue
            const entry = touch(player, session.startsAt)
            if (side === viewerTeam) {
              entry.matchesTogether += 1
              if (viewerWon) entry.matchesWonTogether += 1
            } else {
              entry.matchesAgainst += 1
              if (viewerWon) entry.matchesWonAgainst += 1
            }
          }
        }
      }
    }
  }

  return [...entries.values()].sort(
    (a, b) =>
      b.sharedSessions + b.matchesTogether + b.matchesAgainst - (a.sharedSessions + a.matchesTogether + a.matchesAgainst) ||
      (a.lastPlayedAt < b.lastPlayedAt ? 1 : a.lastPlayedAt > b.lastPlayedAt ? -1 : 0) ||
      (a.userId < b.userId ? -1 : 1),
  )
}

// ---------------------------------------------------------------------------
// Activity feed — genuinely public events only, derived at read time.
// ---------------------------------------------------------------------------

export type FeedEventType = 'session-created' | 'match-finalized'

export interface FeedEvent {
  type: FeedEventType
  actorId: string
  sessionId: string
  sessionTitle: string
  court: string
  startsAt: string
  createdAt: string
  /** Finalized match only: winning side (0 or 1) and team rosters. */
  winner?: 0 | 1
  teams?: string[][]
}

export function deriveActivityFeed(
  sessions: { recordId: string; data: RallySession; createdAt: string }[],
  viewerId: string,
  followedIds: ReadonlySet<string>,
  hiddenActorIds: ReadonlySet<string>,
  options: { followedOnly?: boolean; includeSelf?: boolean; limit?: number } = {},
): FeedEvent[] {
  const followedOnly = options.followedOnly ?? true
  const includeSelf = options.includeSelf ?? true
  const limit = options.limit ?? DEFAULT_LIST_LIMIT
  const events: FeedEvent[] = []
  for (const { recordId, data: session, createdAt } of sessions) {
    if (session.status === 'cancelled') continue
    const actorId = session.hostId
    if (hiddenActorIds.has(actorId)) continue
    const isSelf = actorId === viewerId
    const isFollowed = followedIds.has(actorId)
    if (!isSelf && !isFollowed && followedOnly) continue
    if (isSelf && !includeSelf) continue
    // TODO: if sessions ever gain a private flag, exclude private sessions
    // here — today every session is a public invitation to signed-in members.
    events.push({
      type: 'session-created',
      actorId,
      sessionId: recordId,
      sessionTitle: session.title,
      court: session.court,
      startsAt: session.startsAt,
      createdAt,
    })
    const score = readMatchScore(session.matchScore)
    if (score && resultStatus(score) === 'final' && score.winner !== null) {
      events.push({
        type: 'match-finalized',
        actorId,
        sessionId: recordId,
        sessionTitle: session.title,
        court: session.court,
        startsAt: session.startsAt,
        createdAt,
        winner: score.winner,
        teams: score.teams,
      })
    }
  }
  events.sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.sessionId < b.sessionId ? -1 : 1,
  )
  return events.slice(0, Math.max(1, Math.min(MAX_LIST_LIMIT, limit)))
}

// ---------------------------------------------------------------------------
// Ranked discovery — extends filterGames output with scored reasons.
// ---------------------------------------------------------------------------

export type DiscoveryReason =
  | 'level-match'
  | 'level-open'
  | 'level-gap'
  | 'format-match'
  | 'format-other'
  | 'nearby'
  | 'area-match'
  | 'time-match'
  | 'day-match'
  | 'needs-players'
  | 'target-reached'
  | 'session-full'
  | 'doubles-ready'
  | 'followed-host'

export interface RankedGame extends AnnotatedGame {
  score: number
  reasons: DiscoveryReason[]
}

const REASON_ORDER: DiscoveryReason[] = [
  'level-match',
  'level-open',
  'level-gap',
  'format-match',
  'format-other',
  'nearby',
  'area-match',
  'time-match',
  'day-match',
  'needs-players',
  'target-reached',
  'session-full',
  'doubles-ready',
  'followed-host',
]

function sessionFormatOf(game: AnnotatedGame): SocialFormat | 'other' {
  const format = game.session.format
  if (format === 'Singles') return 'singles'
  if (format === 'Doubles') return 'doubles'
  if (format === 'Practice') return 'practice'
  if (game.session.targetPlayers === 2) return 'singles'
  if (game.session.targetPlayers >= 4) return 'doubles'
  return 'other'
}

export function rankGames(
  games: AnnotatedGame[],
  prefs: DiscoveryPreferences | null,
  options: { followedHostIds?: ReadonlySet<string>; strictLevel?: boolean } = {},
): RankedGame[] {
  const ranked: RankedGame[] = []
  for (const game of games) {
    let score = 0
    const reasons: DiscoveryReason[] = []
    const add = (points: number, reason: DiscoveryReason) => {
      score += points
      reasons.push(reason)
    }
    if (prefs) {
      // Skill compatibility: self-reported levels only, never a verified
      // rating. A two-step gap is demoted hard; a one-step gap is neutral.
      if (prefs.level !== 'All levels') {
        if (game.session.level === prefs.level) add(40, 'level-match')
        else if (game.session.level === 'All levels') add(15, 'level-open')
        else {
          const gap = Math.abs(LEVEL_ORDER[prefs.level] - LEVEL_ORDER[game.session.level as Exclude<Level, 'All levels'>])
          if (gap >= 2) {
            if (options.strictLevel) continue
            add(-30, 'level-gap')
          }
        }
      }
      const format = sessionFormatOf(game)
      if (prefs.formats.length > 0) {
        if (format !== 'other' && prefs.formats.includes(format)) add(30, 'format-match')
        else add(-10, 'format-other')
      }
      if (prefs.area && matchesArea(`${game.session.court} ${game.session.location}`, prefs.area)) {
        add(15, 'area-match')
      }
      if (game.distanceMiles !== null && game.distanceMiles <= prefs.radiusMiles) add(20, 'nearby')
      if (prefs.timeStart && prefs.timeEnd) {
        const start = new Date(game.session.startsAt)
        if (!Number.isNaN(start.getTime())) {
          // v1 limitation, documented: matched in UTC because the server
          // does not know the viewer's IANA zone. A viewer outside UTC
          // should set the window in UTC; storing the viewer's zone is a
          // named follow-up in the contracts doc.
          const hhmm = `${String(start.getUTCHours()).padStart(2, '0')}:${String(start.getUTCMinutes()).padStart(2, '0')}`
          if (hhmm >= prefs.timeStart && hhmm <= prefs.timeEnd) add(10, 'time-match')
          if (prefs.days.length > 0 && prefs.days.includes(start.getUTCDay())) add(5, 'day-match')
        }
      }
    }
    // Capacity awareness (from the integrated capacity + waitlist state).
    if (game.status === 'needs-players') add(10, 'needs-players')
    else if (game.status === 'target-reached') add(5, 'target-reached')
    else if (game.status === 'full') add(-15, 'session-full')
    // Doubles readiness: four confirmed players.
    if (sessionFormatOf(game) === 'doubles' && game.going >= 4) add(10, 'doubles-ready')
    if (options.followedHostIds?.has(game.session.hostId)) add(10, 'followed-host')
    reasons.sort((a, b) => REASON_ORDER.indexOf(a) - REASON_ORDER.indexOf(b))
    ranked.push({ ...game, score, reasons })
  }
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      Date.parse(a.session.startsAt) - Date.parse(b.session.startsAt) ||
      (a.recordId < b.recordId ? -1 : 1),
  )
  return ranked
}

// ---------------------------------------------------------------------------
// Notification hook for Track H (E13).
//
// There is no notifications collection in this base, so this module must NOT
// fabricate notification records. It only builds the typed payload that
// Track H's notification writer should persist when it lands. The hook is
// pure and side-effect free by design.
// ---------------------------------------------------------------------------

export interface SocialNotificationDraft {
  type: 'follow'
  recipientId: string
  actorId: string
  createdAt: string
  deepLink: string
}

export function buildFollowNotification(actorId: string, followeeId: string, now = Date.now()): SocialNotificationDraft {
  return {
    type: 'follow',
    recipientId: followeeId,
    actorId,
    createdAt: new Date(now).toISOString(),
    deepLink: `/players/${encodeURIComponent(actorId)}`,
  }
}
