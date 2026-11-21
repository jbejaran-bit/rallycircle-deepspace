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
import { readMatchScore, isEligibleForStats } from '../lib/rally-score.js'
import { recordPages } from './record-pages.js'
import { buildMatchHistory, summarizePlayerStats, type MatchResultRow, type StatsFormat } from '../lib/match-stats.js'

interface StoredProfileRow {
  recordId: string
  createdBy: string
  data: PlayerProfile
}

type ResultIndexRow = {
  sessionId: string
  resultRevision: number
  finalizedAt: string
}

async function loadVerifiedResults(
  tools: ActionTools,
  userId: string,
  visibility: PlayerProfile['visibility'],
  limit = Infinity,
  includePending = false,
): Promise<MatchResultRow[] | null> {
  const verified = new Map<string, MatchResultRow>()
  try {
    const pages = recordPages<ResultIndexRow>(offset => {
      // The app action adapter forwards the SDK's offset even though the
      // installed ActionTools declaration omits it.
      const options = { where: { userId }, orderBy: 'finalizedAt', orderDir: 'desc' as const, limit: 30, offset }
      return tools.query<ResultIndexRow>('matchResults', options)
    })
    for await (const records of pages) {
      const checked = await Promise.all(records.map(async (record) => {
        const { sessionId, resultRevision, finalizedAt } = record.data
        const result = await tools.get('sessions', sessionId)
        if (!result.success) {
          if (result.error === 'Record not found') return null
          throw new Error('The committed result could not be checked.')
        }
        const session = result.data.record.data
        const score = readMatchScore(typeof session.matchScore === 'string' ? session.matchScore : undefined)
        const format = session.format === 'Singles' ? 'singles' : session.format === 'Doubles' ? 'doubles' : null
        if (!format || session.pendingResult || !score) return null
        const side = score.teams.findIndex(team => team.includes(userId))
        if (side < 0 || score.winner === null) return null
        if (isEligibleForStats(score) && score.revision === resultRevision) {
          return { recordId: record.recordId, sessionId, userId, format, resultRevision, finalizedAt,
            visibility, won: side === score.winner, sets: score.sets, status: 'final' } satisfies MatchResultRow
        }
        // Superseded by a host correction awaiting fresh approval: the
        // outcome must not count in verified statistics, but the match
        // must not vanish from history either. Surface it as pending
        // (visible, not counted) showing the corrected outcome, until
        // re-approval finalizes it in place (issue #23 semantics). All
        // other unverified states (disputed, partially approved,
        // in-progress) stay hidden, as before.
        if (includePending && score.revision !== resultRevision) {
          return { recordId: record.recordId, sessionId, userId, format, resultRevision: score.revision,
            finalizedAt, visibility, won: side === score.winner, sets: score.sets,
            status: 'pending' } satisfies MatchResultRow
        }
        return null
      }))
      for (const row of checked) {
        if (row) verified.set(row.sessionId, row)
        if (verified.size >= limit) return [...verified.values()]
      }
    }
    return [...verified.values()]
  } catch {
    return null
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
  // Page through every owned row: a single capped query (the old limit: 100)
  // left rows past the cap at their previous visibility, so a profile
  // deletion could leave match history publicly readable in storage.
  const pageSize = 100
  for (const collection of ['playerStats', 'matchResults'] as const) {
    let offset = 0
    for (;;) {
      const result = await tools.query<{ visibility: PlayerProfile['visibility'] }>(collection, {
        where: { userId },
        limit: pageSize,
        offset,
      })
      if (!result.success) break
      const records = (result.data as unknown as { records?: Array<{ recordId: string; data: { visibility: string } }> }).records ?? []
      for (const record of records) {
        if (record.data.visibility !== visibility) {
          await tools.update(collection, record.recordId, { visibility })
        }
      }
      if (records.length < pageSize) break
      offset += records.length
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

  const visibility = profile?.data.visibility ?? 'private'
  const rows = await loadVerifiedResults(tools, targetUserId, visibility)
  if (!rows) return failure('stats_unavailable', 'Player statistics could not be loaded.')
  const byFormat = (format: StatsFormat) => summarizePlayerStats(rows, targetUserId, format, visibility)
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
  // History includes pending (corrected, unapproved) entries so a corrected
  // match stays visible instead of vanishing until re-approval; statistics
  // never see them (getPlayerStatsAction loads with includePending false).
  const rows = await loadVerifiedResults(tools, targetUserId, profile?.data.visibility ?? 'private', limit, true)
  if (!rows) return failure('history_unavailable', 'Match history could not be loaded.')
  return {
    success: true,
    data: {
      userId: targetUserId,
      public: true,
      entries: buildMatchHistory(rows),
    },
  }
}

export const getResultAuditAction: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
  if (!sessionId || sessionId.length > 200) return failure('audit_unavailable', 'The result audit is unavailable.')
  const found = await tools.get('sessions', sessionId)
  if (!found.success) return failure('audit_unavailable', 'The result audit is unavailable.')
  const session = found.data.record.data
  const score = readMatchScore(typeof session.matchScore === 'string' ? session.matchScore : undefined)
  if (!score || (session.hostId !== userId && !score.teams.flat().includes(userId))) {
    return failure('audit_unavailable', 'The result audit is unavailable.')
  }
  if (session.pendingResult) return failure('audit_pending', 'The result update is still processing.')
  const rows = await tools.query('resultAudits', { where: { sessionId }, orderBy: 'createdAt', orderDir: 'desc', limit: 50 })
  if (!rows.success) return failure('audit_unavailable', 'The result audit is unavailable.')
  return { success: true, data: { entries: rows.data.records
    .filter(({ data }) => {
      if (typeof data.resultRevision !== 'number' || data.resultRevision > score.revision) return false
      if (data.resultRevision < score.revision) return true
      if (data.kind === 'finalized') return isEligibleForStats(score)
      if (data.kind === 'disputed') return score.disputed
      return data.kind === 'corrected' && score.correctionCount > 0
    })
    .map(row => ({ kind: row.data.kind, detail: row.data.detail, resultRevision: row.data.resultRevision })) } }
}

export const profileActions: Record<string, ActionHandler<Env>> = {
  updateProfile: updateProfileAction,
  deleteProfile: deleteProfileAction,
  getPlayerStats: getPlayerStatsAction,
  getMatchHistory: getMatchHistoryAction,
  getResultAudit: getResultAuditAction,
}
