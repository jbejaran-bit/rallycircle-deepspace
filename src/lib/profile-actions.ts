/**
 * Typed client helpers for the profile / stats actions (Codex integration
 * surface). Mirrors `rally-actions.ts`: every call sends the verified
 * Bearer token, and the response shape is validated before it is used.
 * These helpers never send a `userId` for writes — the server derives the
 * caller from the token.
 */

import { getAuthToken } from 'deepspace'
import type { ProfileCompleteness, ProfileInput, PlayerProfile } from './profile.js'
import type { MatchHistoryEntry, PlayerStatsSummary } from './match-stats.js'

export interface ProfileResponse {
  success: boolean
  data?: {
    recordId: string
    unchanged: boolean
    completeness: ProfileCompleteness
  }
  error?: string
  code?: string
}

export interface PlayerStatsResponse {
  success: boolean
  data?: {
    userId: string
    public: boolean
    profile: Omit<PlayerProfile, 'userId'> | null
    completeness: ProfileCompleteness
    stats: { singles: PlayerStatsSummary; doubles: PlayerStatsSummary }
  }
  error?: string
  code?: string
}

export interface MatchHistoryResponse {
  success: boolean
  data?: {
    userId: string
    public: boolean
    entries: MatchHistoryEntry[]
  }
  error?: string
  code?: string
}

function isActionResponse(value: unknown): value is { success: boolean; data?: Record<string, unknown>; error?: string; code?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  return (
    (result.success === true && typeof result.data === 'object' && result.data !== null) ||
    (result.success === false && typeof result.error === 'string')
  )
}

async function callProfileAction<T extends { success: boolean }>(
  name: string,
  params: Record<string, unknown>,
): Promise<T> {
  const token = await getAuthToken()
  if (!token) throw new Error('Sign in before updating your profile.')
  const response = await fetch(`/api/actions/${name}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  })
  if (response.status === 401) throw new Error('Sign in before updating your profile.')
  const result: unknown = await response.json().catch(() => null)
  if (!isActionResponse(result)) throw new Error('The profile request returned an invalid response.')
  if (!response.ok || !result.success) {
    throw new Error(result.error ?? 'The profile request was rejected.')
  }
  return result as T
}

/** Create or update the caller's own profile. Idempotent on identical input. */
export async function updateProfile(input: ProfileInput): Promise<ProfileResponse> {
  return callProfileAction<ProfileResponse>('updateProfile', input)
}

/** Delete the caller's own profile and withdraw public presence. */
export async function deleteProfile(): Promise<{ success: boolean; data?: { deleted: boolean }; error?: string; code?: string }> {
  return callProfileAction('deleteProfile', {})
}

/** Load one player's public profile + stats (own or public only). */
export async function getPlayerStats(userId: string): Promise<PlayerStatsResponse> {
  return callProfileAction<PlayerStatsResponse>('getPlayerStats', { userId })
}

/** Load one player's finalized match history, newest first (max 50). */
export async function getMatchHistory(userId: string, limit = 20): Promise<MatchHistoryResponse> {
  return callProfileAction<MatchHistoryResponse>('getMatchHistory', { userId, limit })
}
