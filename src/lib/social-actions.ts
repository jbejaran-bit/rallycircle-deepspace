import { getAuthToken } from 'deepspace'
import type { GameFilters, KnownCourtLocation } from './find-games.js'
import type { LatLng } from './geo.js'
import type { DiscoveryPreferences, FeedEvent, PlayedWithEntry, RankedGame, SocialNotificationDraft } from './social.js'

export type SocialActionName =
  | 'followUser'
  | 'unfollowUser'
  | 'blockUser'
  | 'unblockUser'
  | 'reportContent'
  | 'getFollowers'
  | 'getFollowing'
  | 'getMutualFollows'
  | 'getPlayedWith'
  | 'getActivityFeed'
  | 'saveDiscoveryPreferences'
  | 'getDiscoveryPreferences'
  | 'discoverGames'

export interface FollowResult {
  recordId: string
  alreadyFollowing: boolean
  /** Draft payload for Track H's notification writer; null when no notification is due. Not persisted by this call. */
  notification: SocialNotificationDraft | null
}

export interface UserListEntry {
  userId: string
  followedAt: string
}

export interface UserListResult {
  users: UserListEntry[]
  nextCursor: string | null
  /** True when the list is hidden because of a block (either direction). */
  hidden: boolean
}

export interface DiscoverGamesResult {
  games: RankedGame[]
  truncated: boolean
  appliedPreferences: boolean
}

async function callSocialAction<T>(name: SocialActionName, params: Record<string, unknown>): Promise<T> {
  const token = await getAuthToken()
  if (!token) throw new Error('Sign in before using social features.')
  const response = await fetch(`/api/actions/${name}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  if (response.status === 401) throw new Error('Sign in before using social features.')
  const result: unknown = await response.json().catch(() => null)
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new Error('The social request returned an invalid response.')
  }
  const record = result as Record<string, unknown>
  if (!response.ok || record.success !== true) {
    throw new Error(typeof record.error === 'string' ? record.error : 'The social request was rejected.')
  }
  return record.data as T
}

export const followUser = (followeeId: string) => callSocialAction<FollowResult>('followUser', { followeeId })
export const unfollowUser = (followeeId: string) =>
  callSocialAction<{ following: boolean }>('unfollowUser', { followeeId })
export const blockUser = (blockedId: string) => callSocialAction<{ blocked: boolean }>('blockUser', { blockedId })
export const unblockUser = (blockedId: string) => callSocialAction<{ blocked: boolean }>('unblockUser', { blockedId })
export const reportContent = (targetType: 'user' | 'session' | 'content', targetId: string, reason: string) =>
  callSocialAction<{ recordId: string }>('reportContent', { targetType, targetId, reason })

export const getFollowers = (userId: string, limit = 20, before?: string) =>
  callSocialAction<UserListResult>('getFollowers', { userId, limit, ...(before ? { before } : {}) })
export const getFollowing = (userId: string, limit = 20, before?: string) =>
  callSocialAction<UserListResult>('getFollowing', { userId, limit, ...(before ? { before } : {}) })
export const getMutualFollows = (userId: string, limit = 20, before?: string) =>
  callSocialAction<UserListResult>('getMutualFollows', { userId, limit, ...(before ? { before } : {}) })
export const getPlayedWith = (userId?: string) =>
  callSocialAction<{ players: PlayedWithEntry[] }>('getPlayedWith', userId ? { userId } : {})
export const getActivityFeed = (limit = 20, followedOnly = true) =>
  callSocialAction<{ events: FeedEvent[] }>('getActivityFeed', { limit, followedOnly })

export const saveDiscoveryPreferences = (preferences: DiscoveryPreferences) =>
  callSocialAction<{ recordId: string }>('saveDiscoveryPreferences', { preferences })
export const getDiscoveryPreferences = () =>
  callSocialAction<{ preferences: DiscoveryPreferences; saved: boolean }>('getDiscoveryPreferences', {})

export const discoverGames = (
  filters: GameFilters = {},
  options: { limit?: number; strictLevel?: boolean; knownCourts?: KnownCourtLocation[]; userLocation?: LatLng } = {},
) =>
  callSocialAction<DiscoverGamesResult>('discoverGames', {
    filters,
    limit: options.limit ?? 20,
    strictLevel: options.strictLevel ?? false,
    knownCourts: options.knownCourts ?? [],
    ...(options.userLocation ? { userLocation: options.userLocation } : {}),
  })
