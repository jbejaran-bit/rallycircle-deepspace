/**
 * Player profile + statistics query actions.
 *
 * Trust model (see src/server/action-routes.ts): action tools run RBAC-off,
 * so every handler below checks ownership itself. The caller identity is
 * `userId` from the verified action context — any `userId` in `params` is
 * ignored for writes and validated as a mere lookup key for reads.
 *
 * - `updateProfile`: create-or-update the CALLER's own profile. Server-side
 *   zod validation (length/enum/coordinate checks). Idempotent: an
 *   identical re-save is a no-op success. Visibility changes are synced to
 *   the caller's `playerStats`/`matchResults` rows so the record-layer
 *   privacy filter follows the profile.
 * - `deleteProfile`: delete the caller's own profile (idempotent when
 *   absent) and withdraw public presence by marking the caller's stats /
 *   results rows private.
 * - `getPlayerStats` / `getMatchHistory`: authorized reads. A private
 *   profile hides everything except `{ public: false }` from other
 *   callers; the owner always sees their own data.
 *
 * Error codes (stable, see docs/track-bc-contracts.md): `invalid_profile`,
 * `invalid_user`, `profile_unavailable`, `stats_unavailable`,
 * `history_unavailable`.
 */

import type { ActionHandler, ActionTools, MutateActionData } from 'deepspace/worker'
import type { Env } from '../../worker.js'
import {
  isSameProfile,
  profileCompleteness,
  validateProfileInput,
  type PlayerProfile,
  type ProfileInput,
} from '../lib/profile.js'
import { buildMatchHistory, type MatchResultRow, type StatsFormat } from '../lib/match-stats.js'

interface StoredProfileRow {
  recordId: string
  createdBy: string
  data: PlayerProfile
}

interface StoredStatsRow {
  recordId: string
  data: {
    userId: string
    format: StatsFormat
    wins: number
    losses: number
    matchesPlayed: number
    visibility: PlayerProfile['visibility']
  }
}

interface StoredResultRow {
  recordId: string
  data: {
    sessionId: string
    userId: string
    format: StatsFormat
    won: number
    sets: string | Array<[number, number]>
    resultRevision: number
    finalizedAt: string
    visibility: PlayerProfile['visibility']
  }
}

type ProfileLookup =
  | { ok: true; profile: StoredProfileRow | null }
  | { ok: false }

function failure(code: string, error: string) {
  return { success: false as const, code, error }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function findOwnProfile(tools: ActionTools, userId: string): Promise<ProfileLookup> {
  const result = await tools.query<Record<string, unknown>>('profiles', { where: { userId }, limit: 1 })
  if (!result.success) return { ok: false }
  const rows = (result.data as unknown as { records?: StoredProfileRow[] }).records ?? []
  return { ok: true, profile: rows[0] ?? null }
}

/** Set the visibility of every stats/results row the caller owns, where it differs. */
async function syncOwnedVisibility(
  tools: ActionTools,
  userId: string,
  visibility: PlayerProfile['visibility'],
): Promise<void> {
  for (const collection of ['playerStats', 'matchResults'] as const) {
    const result = await tools.query<{ visibility: PlayerProfile['visibility'] }>(collection, {
      where: { userId },
      limit: 100,
    })
    if (!result.success) continue
    const records = (result.data as unknown as { records?: Array<{ recordId: string; data: { visibility: string } }> }).records ?? []
    for (const record of records) {
      if (record.data.visibility !== visibility) {
        await tools.update(collection, record.recordId, { visibility })
      }
    }
  }
}

export const updateProfileAction: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const validated = validateProfileInput(params)
  if (!validated.ok) return failure('invalid_profile', validated.error)
  const input: ProfileInput = validated.data

  const lookup = await findOwnProfile(tools, userId)
  if (!lookup.ok) return failure('profile_unavailable', 'Your profile could not be checked. Try again.')
  const existing = lookup.profile
  if (existing && isSameProfile(input, existing.data)) {
    return {
      success: true,
      data: {
        recordId: existing.recordId,
        unchanged: true,
        completeness: profileCompleteness(existing.data),
      },
    }
  }

  // Capture the previous visibility BEFORE the update: the looked-up row
  // object may alias live storage, so reading existing.data.visibility
  // after tools.update() can already see the new value.
  const previousVisibility = existing?.data.visibility
  const saved = existing
    ? await tools.update('profiles', existing.recordId, input)
    : await tools.create('profiles', input)
  if (!saved.success) return failure('profile_unavailable', 'Your profile could not be saved. Try again.')
  const recordId = existing?.recordId ?? (saved.data as MutateActionData).recordId

  if (!existing || previousVisibility !== input.visibility) {
    await syncOwnedVisibility(tools, userId, input.visibility)
  }
  return {
    success: true,
    data: {
      recordId,
      unchanged: false,
      completeness: profileCompleteness({ ...input, userId }),
    },
  }
}

export const deleteProfileAction: ActionHandler<Env> = async ({ userId, tools }) => {
  const lookup = await findOwnProfile(tools, userId)
  if (!lookup.ok) return failure('profile_unavailable', 'Your profile could not be checked. Try again.')
  if (!lookup.profile) return { success: true, data: { deleted: false } }
  const removed = await tools.remove('profiles', lookup.profile.recordId)
  if (!removed.success) return failure('profile_unavailable', 'Your profile could not be deleted. Try again.')
  // Withdrawing public presence: stats and results rows become private.
  await syncOwnedVisibility(tools, userId, 'private')
  return { success: true, data: { deleted: true } }
}

function validTargetUserId(params: unknown): string | null {
  if (!isRecord(params) || typeof params.userId !== 'string') return null
  const userId = params.userId.trim()
  return userId.length >= 1 && userId.length <= 200 ? userId : null
}

export const getPlayerStatsAction: ActionHandler<Env> = async ({ userId: callerId, params, tools }) => {
  const targetUserId = validTargetUserId(params)
  if (!targetUserId) return failure('invalid_user', 'A player id is required.')
  const lookup = await findOwnProfile(tools, targetUserId)
  if (!lookup.ok) return failure('stats_unavailable', 'Player statistics could not be loaded.')
  const profile = lookup.profile
  const isOwner = callerId === targetUserId
  if (!isOwner && profile?.data.visibility !== 'public') {
    return { success: true, data: { userId: targetUserId, public: false } }
  }

  const statsResult = await tools.query<StoredStatsRow['data']>('playerStats', {
    where: { userId: targetUserId },
    limit: 2,
  })
  if (!statsResult.success) return failure('stats_unavailable', 'Player statistics could not be loaded.')
  const rows = (statsResult.data as unknown as { records?: StoredStatsRow[] }).records ?? []
  const visibility = profile?.data.visibility ?? 'public'
  const byFormat = (format: StatsFormat) => {
    const row = rows.find((record) => record.data.format === format)
    if (!row) {
      return {
        userId: targetUserId,
        format,
        wins: 0,
        losses: 0,
        matchesPlayed: 0,
        winRate: null,
        provisional: true,
        visibility,
      }
    }
    return {
      userId: targetUserId,
      format,
      wins: row.data.wins,
      losses: row.data.losses,
      matchesPlayed: row.data.matchesPlayed,
      winRate: row.data.matchesPlayed === 0 ? null : row.data.wins / row.data.matchesPlayed,
      provisional: row.data.matchesPlayed < 5,
      visibility: row.data.visibility,
    }
  }
  return {
    success: true,
    data: {
      userId: targetUserId,
      public: true,
      profile: profile
        ? {
          displayName: profile.data.displayName,
          bio: profile.data.bio,
          formats: profile.data.formats,
          preferredArea: profile.data.preferredArea,
          selfReportedLevel: profile.data.selfReportedLevel,
          visibility: profile.data.visibility,
        }
        : null,
      completeness: profileCompleteness(profile?.data ?? null),
      stats: { singles: byFormat('singles'), doubles: byFormat('doubles') },
    },
  }
}

export const getMatchHistoryAction: ActionHandler<Env> = async ({ userId: callerId, params, tools }) => {
  const targetUserId = validTargetUserId(params)
  if (!targetUserId) return failure('invalid_user', 'A player id is required.')
  const lookup = await findOwnProfile(tools, targetUserId)
  if (!lookup.ok) return failure('history_unavailable', 'Match history could not be loaded.')
  const profile = lookup.profile
  const isOwner = callerId === targetUserId
  if (!isOwner && profile?.data.visibility !== 'public') {
    return { success: true, data: { userId: targetUserId, public: false, entries: [] } }
  }
  const requested = isRecord(params) && typeof params.limit === 'number' ? Math.floor(params.limit) : 20
  const limit = Math.min(50, Math.max(1, requested))
  const result = await tools.query<StoredResultRow['data']>('matchResults', {
    where: { userId: targetUserId },
    orderBy: 'finalizedAt',
    orderDir: 'desc',
    limit,
  })
  if (!result.success) return failure('history_unavailable', 'Match history could not be loaded.')
  const records = (result.data as unknown as { records?: StoredResultRow[] }).records ?? []
  const rows: MatchResultRow[] = records.map((record) => ({
    recordId: record.recordId,
    sessionId: record.data.sessionId,
    userId: record.data.userId,
    format: record.data.format,
    won: record.data.won === 1,
    sets: typeof record.data.sets === 'string' ? JSON.parse(record.data.sets) as Array<[number, number]> : record.data.sets,
    resultRevision: record.data.resultRevision,
    finalizedAt: record.data.finalizedAt,
    visibility: record.data.visibility,
  }))
  return {
    success: true,
    data: {
      userId: targetUserId,
      public: true,
      entries: buildMatchHistory(rows),
    },
  }
}

export const profileActions: Record<string, ActionHandler<Env>> = {
  updateProfile: updateProfileAction,
  deleteProfile: deleteProfileAction,
  getPlayerStats: getPlayerStatsAction,
  getMatchHistory: getMatchHistoryAction,
}
