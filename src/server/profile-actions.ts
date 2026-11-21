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
import { buildMatchHistory, normalizeResultStatus, parseStoredSets, summarizePlayerStats, type MatchResultRow, type StatsFormat } from '../lib/match-stats.js'

interface StoredProfileRow {
  recordId: string
  createdBy: string
  data: PlayerProfile
}

/**
 * Stored `matchResults` row as read back from the collection. `status` is
 * absent on rows written before the status column existed (they count as
 * 'final': they were written only on finalization).
 */
type StoredResultRow = {
  sessionId: string
  userId: string
  format: string
  won: number
  sets: unknown
  resultRevision: number
  finalizedAt: string
  status?: string
}

/**
 * Load one player's verified results, newest first, up to `limit` entries.
 *
 * Aggregation design (fix for the getPlayerStats unbounded scan): the
 * serialized command room maintains a write-side `status` on every row
 * (finalization writes 'final'; a correction flips rows to 'pending' and
 * a dispute to 'disputed' before the session score commits), so this read
 * path can trust the stored outcome for 'final' rows with ZERO session
 * GETs — getPlayerStats costs one paged query per 30 rows and nothing
 * per row, no matter how many results a player has. The old code fetched
 * every session (N results = N session GETs, `limit: Infinity`).
 *
 * Only 'pending' rows cost a session GET (at most one per history entry,
 * bounded by the history limit ≤ 50): the corrected outcome lives only in
 * the session until re-approval finalizes it in place, so the entry is
 * derived from the committed session score. Statistics never needs pending
 * rows (they are excluded from totals either way), so `includePending`
 * stays false there and getPlayerStats issues zero session GETs even when
 * the player has pending corrections. A pending row whose session
 * revision has NOT moved past the row's revision has no committed
 * correction to show (the correction's session commit failed and the
 * retry has not landed yet) — the entry is dropped, fail closed, and
 * reappears once the retry commits. A pending row is NEVER self-healed
 * to 'final' on read: a revision match here is exactly the failed-commit
 * window, and healing it would count the superseded outcome while the
 * correction is still in flight. Re-approval heals the row on the write
 * path instead.
 *
 * Disputed rows and rows with an unknown status or corrupt stored sets
 * are dropped (fail closed), never counted, never shown.
 */
async function loadVerifiedResults(
  tools: ActionTools,
  userId: string,
  visibility: PlayerProfile['visibility'],
  limit = Infinity,
  includePending = false,
): Promise<MatchResultRow[] | null> {
  const verified = new Map<string, MatchResultRow>()
  try {
    const pages = recordPages<StoredResultRow>(offset => {
      // The app action adapter forwards the SDK's offset even though the
      // installed ActionTools declaration omits it.
      const options = { where: { userId }, orderBy: 'finalizedAt', orderDir: 'desc' as const, limit: 30, offset }
      return tools.query<StoredResultRow>('matchResults', options)
    })
    for await (const records of pages) {
      // Page-granular over-fetch (perf audit, package 8): without this slice
      // a history call with limit 50 issued 60 session GETs — the second
      // 30-row page was checked in full although only 20 more verified rows
      // were needed. Check only the rows still needed; a page that yields
      // fewer verified rows than checked simply continues to the next page.
      // For stats (limit Infinity) the slice is a no-op.
      const remaining = limit - verified.size
      const needed = Number.isFinite(remaining) ? records.slice(0, remaining) : records
      const checked = await Promise.all(needed.map(async (record) => {
        const { sessionId, resultRevision, finalizedAt } = record.data
        const status = normalizeResultStatus(record.data.status)
        // Disputed rows are hidden from both statistics and history.
        // Cancelled rows (migration F4, write-side form): the session was
        // cancelled and the room flipped its rows to 'cancelled' at cancel
        // time, so the result must not count or appear anywhere.
        if (!status || status === 'disputed' || status === 'cancelled') return null
        if (status === 'pending' && !includePending) return null
        const format = record.data.format === 'singles' ? 'singles' : record.data.format === 'doubles' ? 'doubles' : null
        if (!format) return null
        if (status === 'final') {
          // Trust the stored outcome: the row was written (or re-finalized
          // in place) by the serialized command room at this revision, and
          // any later correction/dispute flips the status before the
          // session score commits. No session GET.
          const sets = parseStoredSets(record.data.sets)
          if (!sets) return null
          return { recordId: record.recordId, sessionId, userId, format, resultRevision, finalizedAt,
            visibility, won: record.data.won === 1, sets, status: 'final' } satisfies MatchResultRow
        }
        // Pending: derive the corrected outcome from the committed session
        // score (one GET, bounded by the history limit). The stored row
        // still carries the superseded outcome, which must never be shown.
        const result = await tools.get('sessions', sessionId)
        if (!result.success) {
          if (result.error === 'Record not found') return null
          throw new Error('The committed result could not be checked.')
        }
        const session = result.data.record.data
        const score = readMatchScore(typeof session.matchScore === 'string' ? session.matchScore : undefined)
        if (!score || score.winner === null || score.disputed || score.revision <= resultRevision) return null
        const side = score.teams.findIndex(team => team.includes(userId))
        if (side < 0) return null
        return { recordId: record.recordId, sessionId, userId, format, resultRevision: score.revision, finalizedAt,
          visibility, won: side === score.winner, sets: score.sets, status: 'pending' } satisfies MatchResultRow
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
  // (Port branch's paged version, kept in the combined branch — the stats
  // branch's copy of this file still had the single capped query.)
  const pageSize = 100
  for (const collection of ['playerStats', 'matchResults'] as const) {
    let offset = 0
    for (;;) {
      // The app action adapter forwards the SDK's offset even though the
      // installed ActionTools declaration omits it (same pattern as
      // loadVerifiedResults below).
      const options = { where: { userId }, limit: pageSize, offset }
      const result = await tools.query<{ visibility: PlayerProfile['visibility'] }>(collection, options)
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
