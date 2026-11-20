import type { ActionHandler, ActionResult, ActionTools } from 'deepspace/worker'
import { filterGames, type AnnotatedGame, type GameFilters, type KnownCourtLocation } from '../lib/find-games.js'
import { isValidLatLng, type LatLng } from '../lib/geo.js'
import type { Level, RallyRSVP, RallySession } from '../lib/rally.js'
import {
  buildFollowNotification,
  clampListLimit,
  decodePreferences,
  deriveActivityFeed,
  derivePlayedWith,
  encodePreferences,
  LIST_PAGE_WINDOW,
  pageByCreatedAt,
  rankGames,
  validatePreferences,
  validateUserId,
  type DiscoveryPreferences,
  type FeedEvent,
  type PlayedWithEntry,
  type RankedGame,
} from '../lib/social.js'
import type { Env } from '../../worker.js'

// Social graph + discovery server actions (Tracks E + F).
//
// Trust model — read before adding an action (same as action-routes.ts):
// action tools run RBAC-off, so every handler below derives identity ONLY
// from `userId` (the verified Bearer token). A `userId` in `params` is never
// trusted. All writes go through these handlers; the social schemas close
// direct client writes for every role.
//
// Rate limits are enforced here, server-side, from the records themselves:
// follows are capped at 30 new follows per rolling 60 seconds and 500 total;
// reports at 20 per rolling hour. Unfollow/block/unblock are not rate
// limited (destructive, low abuse value) and are idempotent.
//
// Notifications (E13): there is no notifications collection in this base,
// so this module never fabricates notification records. followUser returns
// a `notification` draft payload (see buildFollowNotification) that Track H's
// notification writer should persist when it lands.

type SocialActionResult<T> = ActionResult<T>

interface FollowRecord {
  followerId: string
  followeeId: string
}

interface BlockRecord {
  blockerId: string
  blockedId: string
}

interface ReportRecord {
  reporterId: string
  targetType: 'user' | 'session' | 'content'
  targetId: string
  reason: string
  status: 'open' | 'reviewed' | 'dismissed'
}

interface StoredRecord<T> {
  recordId: string
  data: T
  createdAt: string
  updatedAt: string
}

type Tools = ActionTools

const FOLLOW_RATE_WINDOW_MS = 60_000
const FOLLOW_RATE_MAX = 30
const FOLLOW_TOTAL_CAP = 500
const REPORT_RATE_WINDOW_MS = 3_600_000
const REPORT_RATE_MAX = 20
const DISCOVERY_SESSION_WINDOW = 200
const DISCOVERY_RSVP_WINDOW = 500

function failure<T>(error: string): SocialActionResult<T> {
  return { success: false, error }
}

function paramString(params: Record<string, unknown>, key: string): string | null {
  const value = params[key]
  return typeof value === 'string' ? value : null
}

async function queryAll<T>(
  tools: Tools,
  collection: string,
  where: Record<string, unknown>,
  limit: number,
  orderBy = 'createdAt',
  orderDir: 'asc' | 'desc' = 'desc',
): Promise<StoredRecord<T>[] | null> {
  const result = await tools.query(collection, { where, limit, orderBy, orderDir })
  if (!result.success) return null
  return result.data.records as unknown as StoredRecord<T>[]
}

/** Returns undefined when the query itself failed (callers must fail closed), null when no row exists. */
async function findOne<T>(
  tools: Tools,
  collection: string,
  where: Record<string, unknown>,
): Promise<StoredRecord<T> | null | undefined> {
  const records = await queryAll<T>(tools, collection, where, 1)
  if (records === null) return undefined
  return records[0] ?? null
}

/** True when a blocks row exists in either direction. Errors fail closed. */
async function isBlockedEitherWay(tools: Tools, a: string, b: string): Promise<boolean | null> {
  const first = await findOne<BlockRecord>(tools, 'blocks', { blockerId: a, blockedId: b })
  if (first === undefined) return null
  if (first) return true
  const second = await findOne<BlockRecord>(tools, 'blocks', { blockerId: b, blockedId: a })
  if (second === undefined) return null
  return second !== null
}

/** Count of the caller's records in `collection` created within the window. Null on query failure. */
async function recentCount(
  tools: Tools,
  collection: string,
  userField: string,
  userId: string,
  windowMs: number,
  now: number,
): Promise<number | null> {
  const records = await queryAll<Record<string, unknown>>(tools, collection, { [userField]: userId }, 64, 'createdAt', 'desc')
  if (records === null) return null
  return records.filter(record => {
    const at = Date.parse(record.createdAt)
    return Number.isFinite(at) && now - at < windowMs
  }).length
}

const followUser: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const followeeId = paramString(params, 'followeeId')
  if (!validateUserId(followeeId)) return failure('Choose a player to follow.')
  if (followeeId === userId) return failure('You cannot follow yourself.')
  const blocked = await isBlockedEitherWay(tools, userId, followeeId)
  if (blocked === null) return failure('Your follow could not be checked. Try again.')
  if (blocked) return failure('This player is not available.')
  const existing = await findOne<FollowRecord>(tools, 'follows', { followerId: userId, followeeId })
  if (existing === undefined) return failure('Your follow could not be checked. Try again.')
  if (existing) {
    return { success: true, data: { recordId: existing.recordId, alreadyFollowing: true, notification: null } }
  }
  const recent = await recentCount(tools, 'follows', 'followerId', userId, FOLLOW_RATE_WINDOW_MS, Date.now())
  if (recent === null) return failure('Your follow could not be checked. Try again.')
  if (recent >= FOLLOW_RATE_MAX) return failure('You are following too quickly. Wait a minute and try again.')
  const total = await queryAll<FollowRecord>(tools, 'follows', { followerId: userId }, FOLLOW_TOTAL_CAP + 1)
  if (total === null) return failure('Your follow could not be checked. Try again.')
  if (total.length >= FOLLOW_TOTAL_CAP) return failure('You have reached the follow limit.')
  const created = await tools.create('follows', { followeeId })
  if (!created.success) {
    // A concurrent duplicate follow can lose the uniqueOn race; re-read so
    // the retry is a no-op success instead of a spurious error.
    const retry = await findOne<FollowRecord>(tools, 'follows', { followerId: userId, followeeId })
    if (retry) {
      return { success: true, data: { recordId: retry.recordId, alreadyFollowing: true, notification: null } }
    }
    return failure('Your follow could not be saved.')
  }
  return {
    success: true,
    data: {
      recordId: created.data.recordId,
      alreadyFollowing: false,
      notification: buildFollowNotification(userId, followeeId),
    },
  }
}

const unfollowUser: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const followeeId = paramString(params, 'followeeId')
  if (!validateUserId(followeeId)) return failure('Choose a player to unfollow.')
  const existing = await findOne<FollowRecord>(tools, 'follows', { followerId: userId, followeeId })
  if (existing === undefined) return failure('Your follow could not be checked. Try again.')
  if (existing) {
    const removed = await tools.remove('follows', existing.recordId)
    if (!removed.success) return failure('Your unfollow could not be saved.')
  }
  return { success: true, data: { following: false } }
}

const blockUser: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const blockedId = paramString(params, 'blockedId')
  if (!validateUserId(blockedId)) return failure('Choose a player to block.')
  if (blockedId === userId) return failure('You cannot block yourself.')
  const existing = await findOne<BlockRecord>(tools, 'blocks', { blockerId: userId, blockedId })
  if (existing === undefined) return failure('Your block could not be checked. Try again.')
  if (!existing) {
    const created = await tools.create('blocks', { blockedId })
    if (!created.success) {
      const retry = await findOne<BlockRecord>(tools, 'blocks', { blockerId: userId, blockedId })
      if (!retry) return failure('Your block could not be saved.')
    }
  }
  // Blocking severs the follow relationship in both directions, so a blocked
  // player stops appearing in each other's activity and lists.
  await tools.deleteWhere('follows', { followerId: userId, followeeId: blockedId })
  await tools.deleteWhere('follows', { followerId: blockedId, followeeId: userId })
  return { success: true, data: { blocked: true } }
}

const unblockUser: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const blockedId = paramString(params, 'blockedId')
  if (!validateUserId(blockedId)) return failure('Choose a player to unblock.')
  const existing = await findOne<BlockRecord>(tools, 'blocks', { blockerId: userId, blockedId })
  if (existing === undefined) return failure('Your block could not be checked. Try again.')
  if (existing) {
    const removed = await tools.remove('blocks', existing.recordId)
    if (!removed.success) return failure('Your unblock could not be saved.')
  }
  return { success: true, data: { blocked: false } }
}

const reportContent: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const targetType = paramString(params, 'targetType')
  const targetId = paramString(params, 'targetId')
  const reason = paramString(params, 'reason')
  if (targetType !== 'user' && targetType !== 'session' && targetType !== 'content') {
    return failure('Choose what you are reporting.')
  }
  if (!validateUserId(targetId)) return failure('Choose what you are reporting.')
  if (typeof reason !== 'string' || reason.trim().length < 1 || reason.trim().length > 500) {
    return failure('Describe the problem in 1–500 characters.')
  }
  const recent = await recentCount(tools, 'reports', 'reporterId', userId, REPORT_RATE_WINDOW_MS, Date.now())
  if (recent === null) return failure('Your report could not be checked. Try again.')
  if (recent >= REPORT_RATE_MAX) return failure('You have sent too many reports. Try again later.')
  const created = await tools.create('reports', {
    targetType,
    targetId,
    reason: reason.trim(),
    status: 'open',
  })
  if (!created.success) return failure('Your report could not be saved.')
  return { success: true, data: { recordId: created.data.recordId } }
}

interface ListParams {
  targetUserId: string
  limit: number
  before?: string
}

function parseListParams(userId: string, params: Record<string, unknown>): ListParams | string {
  const targetUserId = paramString(params, 'userId') ?? userId
  if (!validateUserId(targetUserId)) return 'Choose a player.'
  const before = paramString(params, 'before')
  if (before !== null && !Number.isFinite(Date.parse(before))) return 'The page cursor is invalid.'
  return { targetUserId, limit: clampListLimit(params.limit), before: before ?? undefined }
}

const getFollowers: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const parsed = parseListParams(userId, params)
  if (typeof parsed === 'string') return failure(parsed)
  const blocked = await isBlockedEitherWay(tools, userId, parsed.targetUserId)
  if (blocked === null) return failure('The followers list could not be loaded. Try again.')
  if (blocked && parsed.targetUserId !== userId) {
    return { success: true, data: { users: [], nextCursor: null, hidden: true } }
  }
  const records = await queryAll<FollowRecord>(tools, 'follows', { followeeId: parsed.targetUserId }, LIST_PAGE_WINDOW, 'createdAt', 'desc')
  if (records === null) return failure('The followers list could not be loaded. Try again.')
  const { page, nextCursor } = pageByCreatedAt(records, parsed.limit, parsed.before)
  return {
    success: true,
    data: {
      users: page.map(record => ({ userId: record.data.followerId, followedAt: record.createdAt })),
      nextCursor,
      hidden: false,
    },
  }
}

const getFollowing: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const parsed = parseListParams(userId, params)
  if (typeof parsed === 'string') return failure(parsed)
  const blocked = await isBlockedEitherWay(tools, userId, parsed.targetUserId)
  if (blocked === null) return failure('The following list could not be loaded. Try again.')
  if (blocked && parsed.targetUserId !== userId) {
    return { success: true, data: { users: [], nextCursor: null, hidden: true } }
  }
  const records = await queryAll<FollowRecord>(tools, 'follows', { followerId: parsed.targetUserId }, LIST_PAGE_WINDOW, 'createdAt', 'desc')
  if (records === null) return failure('The following list could not be loaded. Try again.')
  const { page, nextCursor } = pageByCreatedAt(records, parsed.limit, parsed.before)
  return {
    success: true,
    data: {
      users: page.map(record => ({ userId: record.data.followeeId, followedAt: record.createdAt })),
      nextCursor,
      hidden: false,
    },
  }
}

/** User ids whose events the viewer must never see (blocked either way). */
async function hiddenActorIds(tools: Tools, viewerId: string): Promise<Set<string> | null> {
  const hidden = new Set<string>()
  const byViewer = await queryAll<BlockRecord>(tools, 'blocks', { blockerId: viewerId }, LIST_PAGE_WINDOW)
  if (byViewer === null) return null
  for (const record of byViewer) hidden.add(record.data.blockedId)
  const byOthers = await queryAll<BlockRecord>(tools, 'blocks', { blockedId: viewerId }, LIST_PAGE_WINDOW)
  if (byOthers === null) return null
  for (const record of byOthers) hidden.add(record.data.blockerId)
  return hidden
}

const getMutualFollows: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const parsed = parseListParams(userId, params)
  if (typeof parsed === 'string') return failure(parsed)
  if (parsed.targetUserId === userId) {
    return { success: true, data: { users: [], nextCursor: null, hidden: false } }
  }
  const blocked = await isBlockedEitherWay(tools, userId, parsed.targetUserId)
  if (blocked === null) return failure('Mutual follows could not be loaded. Try again.')
  if (blocked) return { success: true, data: { users: [], nextCursor: null, hidden: true } }
  const mine = await queryAll<FollowRecord>(tools, 'follows', { followerId: userId }, LIST_PAGE_WINDOW, 'createdAt', 'desc')
  if (mine === null) return failure('Mutual follows could not be loaded. Try again.')
  const theirs = await queryAll<FollowRecord>(tools, 'follows', { followerId: parsed.targetUserId }, LIST_PAGE_WINDOW, 'createdAt', 'desc')
  if (theirs === null) return failure('Mutual follows could not be loaded. Try again.')
  const theirIds = new Set(theirs.map(record => record.data.followeeId))
  const mutual = mine.filter(record => theirIds.has(record.data.followeeId))
  const { page, nextCursor } = pageByCreatedAt(mutual, parsed.limit, parsed.before)
  return {
    success: true,
    data: {
      users: page.map(record => ({ userId: record.data.followeeId, followedAt: record.createdAt })),
      nextCursor,
      hidden: false,
    },
  }
}

const getPlayedWith: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const targetUserId = paramString(params, 'userId') ?? userId
  if (!validateUserId(targetUserId)) return failure('Choose a player.')
  if (targetUserId !== userId) {
    const blocked = await isBlockedEitherWay(tools, userId, targetUserId)
    if (blocked === null) return failure('The played-with list could not be loaded. Try again.')
    if (blocked) return { success: true, data: { players: [] as PlayedWithEntry[] } }
  }
  const hidden = await hiddenActorIds(tools, userId)
  if (hidden === null) return failure('The played-with list could not be loaded. Try again.')
  const myRsvps = await queryAll<RallyRSVP>(tools, 'rsvps', { userId: targetUserId, status: 'going' }, LIST_PAGE_WINDOW)
  if (myRsvps === null) return failure('The played-with list could not be loaded. Try again.')
  const sessionIds = [...new Set(myRsvps.map(record => record.data.sessionId))]
  const sessions: StoredRecord<RallySession>[] = []
  for (const sessionId of sessionIds.slice(0, LIST_PAGE_WINDOW)) {
    const result = await tools.get('sessions', sessionId)
    if (result.success) sessions.push(result.data.record as unknown as StoredRecord<RallySession>)
  }
  // Sessions the target hosted but did not RSVP to.
  const hosted = await queryAll<RallySession>(tools, 'sessions', { hostId: targetUserId }, LIST_PAGE_WINDOW, 'createdAt', 'desc')
  if (hosted === null) return failure('The played-with list could not be loaded. Try again.')
  const seen = new Set(sessions.map(session => session.recordId))
  for (const session of hosted) {
    if (!seen.has(session.recordId)) sessions.push(session)
  }
  const allSessionIds = sessions.map(session => session.recordId)
  const rsvps: RallyRSVP[] = []
  for (const sessionId of allSessionIds) {
    const rows = await queryAll<RallyRSVP>(tools, 'rsvps', { sessionId }, 50)
    if (rows === null) return failure('The played-with list could not be loaded. Try again.')
    for (const row of rows) rsvps.push(row.data)
  }
  const players = derivePlayedWith(sessions, rsvps, targetUserId).filter(entry => !hidden.has(entry.userId))
  return { success: true, data: { players } }
}

const getActivityFeed: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const limit = clampListLimit(params.limit)
  const followedOnly = params.followedOnly !== false
  const followed = await queryAll<FollowRecord>(tools, 'follows', { followerId: userId }, LIST_PAGE_WINDOW, 'createdAt', 'desc')
  if (followed === null) return failure('The activity feed could not be loaded. Try again.')
  const followedIds = new Set(followed.map(record => record.data.followeeId))
  const hidden = await hiddenActorIds(tools, userId)
  if (hidden === null) return failure('The activity feed could not be loaded. Try again.')
  const sessions = await queryAll<RallySession>(tools, 'sessions', { status: 'open' }, 100, 'createdAt', 'desc')
  if (sessions === null) return failure('The activity feed could not be loaded. Try again.')
  const events: FeedEvent[] = deriveActivityFeed(sessions, userId, followedIds, hidden, {
    followedOnly,
    includeSelf: true,
    limit,
  })
  return { success: true, data: { events } }
}

const saveDiscoveryPreferences: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const preferences = params.preferences as DiscoveryPreferences | undefined
  const error = validatePreferences(preferences)
  if (error) return failure(error)
  const existing = await findOne<Record<string, unknown>>(tools, 'discoveryPreferences', { userId })
  if (existing === undefined) return failure('Your preferences could not be checked. Try again.')
  const data = encodePreferences(preferences as DiscoveryPreferences)
  if (existing) {
    const updated = await tools.update('discoveryPreferences', existing.recordId, data)
    if (!updated.success) return failure('Your preferences could not be saved.')
    return { success: true, data: { recordId: existing.recordId } }
  }
  const created = await tools.create('discoveryPreferences', data)
  if (!created.success) return failure('Your preferences could not be saved.')
  return { success: true, data: { recordId: created.data.recordId } }
}

const getDiscoveryPreferences: ActionHandler<Env> = async ({ userId, tools }) => {
  const existing = await findOne<Record<string, unknown>>(tools, 'discoveryPreferences', { userId })
  if (existing === undefined) return failure('Your preferences could not be loaded. Try again.')
  if (!existing) {
    return {
      success: true,
      data: {
        preferences: { formats: [], level: 'All levels', area: '', radiusMiles: 10, timeStart: '', timeEnd: '', days: [] },
        saved: false,
      },
    }
  }
  return { success: true, data: { preferences: decodePreferences(existing.data), saved: true } }
}

function parseKnownCourts(value: unknown): KnownCourtLocation[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 100) return null
  const courts: KnownCourtLocation[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
    const court = item as Record<string, unknown>
    if (typeof court.name !== 'string' || court.name.length < 1 || court.name.length > 200) return null
    if (typeof court.lat !== 'number' || typeof court.lng !== 'number') return null
    if (!isValidLatLng({ lat: court.lat, lng: court.lng })) return null
    courts.push({ name: court.name, lat: court.lat, lng: court.lng })
  }
  return courts
}

const discoverGames: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const limit = clampListLimit(params.limit)
  const strictLevel = params.strictLevel === true
  const filters = (params.filters ?? {}) as GameFilters
  if (filters.maxDistanceMiles !== undefined &&
      (typeof filters.maxDistanceMiles !== 'number' || filters.maxDistanceMiles < 1 || filters.maxDistanceMiles > 100)) {
    return failure('Choose a search radius of 1–100 miles.')
  }
  const knownCourts = parseKnownCourts(params.knownCourts)
  if (knownCourts === null) return failure('Known courts must be a list of up to 100 named locations.')
  const userLocation = params.userLocation as LatLng | undefined
  if (userLocation !== undefined && !isValidLatLng(userLocation)) return failure('Provide a valid location.')
  const prefsRecord = await findOne<Record<string, unknown>>(tools, 'discoveryPreferences', { userId })
  if (prefsRecord === undefined) return failure('Discovery could not be loaded. Try again.')
  const prefs = prefsRecord ? decodePreferences(prefsRecord.data) : null
  const followed = await queryAll<FollowRecord>(tools, 'follows', { followerId: userId }, LIST_PAGE_WINDOW)
  if (followed === null) return failure('Discovery could not be loaded. Try again.')
  const followedHostIds = new Set(followed.map(record => record.data.followeeId))
  const sessionRows = await queryAll<RallySession>(tools, 'sessions', { status: 'open' }, DISCOVERY_SESSION_WINDOW, 'startsAt', 'asc')
  if (sessionRows === null) return failure('Discovery could not be loaded. Try again.')
  const truncatedSessions = sessionRows.length >= DISCOVERY_SESSION_WINDOW
  const rsvpRows = await queryAll<RallyRSVP>(tools, 'rsvps', {}, DISCOVERY_RSVP_WINDOW)
  if (rsvpRows === null) return failure('Discovery could not be loaded. Try again.')
  const truncatedRsvps = rsvpRows.length >= DISCOVERY_RSVP_WINDOW
  const games = filterGames(
    sessionRows.map(record => ({ recordId: record.recordId, data: record.data })),
    rsvpRows.map(record => record.data),
    filters,
    { userId, userLocation, knownCourts },
  )
  const ranked: RankedGame[] = rankGames(games, prefs, { followedHostIds, strictLevel })
  return {
    success: true,
    data: {
      games: ranked.slice(0, limit),
      truncated: truncatedSessions || truncatedRsvps,
      appliedPreferences: prefs !== null,
    },
  }
}

export const socialActions: Record<string, ActionHandler<Env>> = {
  followUser,
  unfollowUser,
  blockUser,
  unblockUser,
  reportContent,
  getFollowers,
  getFollowing,
  getMutualFollows,
  getPlayedWith,
  getActivityFeed,
  saveDiscoveryPreferences,
  getDiscoveryPreferences,
  discoverGames,
}
