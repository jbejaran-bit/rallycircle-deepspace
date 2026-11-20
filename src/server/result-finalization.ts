/**
 * Result finalization → statistics, match history, and audit trail.
 *
 * This module is the only writer of `playerStats`, `matchResults`, and
 * `resultAudits`. It runs inside the RallyCommandRoom's per-session
 * serialised queue, so finalization for one session can never race itself.
 *
 * Flow (C02/C05/C06/C09/C13):
 * - When a result finalizes (last approval), `applyFinalization` writes one
 *   `matchResults` row per player, increments each player's `playerStats`
 *   row, and writes a `finalized` audit row. Practice matches are skipped
 *   (they are not competitive results) and stats stay singles/doubles
 *   separate.
 * - Idempotency (C04/C09/D09): the guard is the `matchResults` rows
 *   themselves. If rows already exist at this result revision, the stats
 *   were already applied: the function reconciles stats from the rows and
 *   ensures the audit row exists, then returns success without counting
 *   anything twice. A retry after a partial failure therefore repairs
 *   instead of double-counting — the same repair-on-next-command pattern
 *   the waitlist uses (A02).
 * - Correction (C06): before a finalized result is replaced,
 *   `reverseFinalization` subtracts the old outcome from each player's
 *   stats (floored at zero). The `matchResults` rows stay in place and are
 *   updated to the new outcome when the corrected result finalizes again;
 *   the superseded outcome survives only in the `corrected` audit row.
 * - Disputes never touch stats: a disputed result is not final, so no
 *   rows exist to reverse (C05/C12).
 * - Privacy (C14): every stats/results row carries a `visibility` copied
 *   from the player's profile at write time ('private' when the profile
 *   is private, 'public' otherwise — including when the player has no
 *   profile). The collections enforce it at the record layer via
 *   `visibilityField` + read 'published'.
 *
 * Partial-failure window, stated honestly: the writes are sequential, not
 * a multi-record transaction (the SDK exposes no transaction across
 * collections). If the worker dies mid-finalization, the next score
 * command for the session re-enters `applyFinalization` through its guard
 * and reconciles. `reconcilePlayerStats` is also exported so an explicit
 * repair can be triggered later if needed.
 */

import type { ActionResult, MutateActionData, QueryActionData } from 'deepspace/worker'
import type { RallySession } from '../lib/rally.js'
import type { MatchScore } from '../lib/rally-score.js'
import type { ProfileVisibility } from '../lib/profile.js'
import type { StatsFormat } from '../lib/match-stats.js'

export type FinalizationTool = <T>(
  tool: string,
  params: Record<string, unknown>,
  userId: string,
) => Promise<ActionResult<T>>

type StoredRow<T> = { recordId: string; data: T }

interface PlayerStatsRow {
  userId: string
  format: StatsFormat
  wins: number
  losses: number
  matchesPlayed: number
  visibility: ProfileVisibility
}

interface MatchResultRowData {
  sessionId: string
  userId: string
  format: StatsFormat
  won: number
  sets: string
  resultRevision: number
  finalizedAt: string
  visibility: ProfileVisibility
}

interface ProfileRowData {
  userId: string
  visibility: ProfileVisibility
}

interface AuditRowData {
  sessionId: string
  userId: string
  kind: 'finalized' | 'disputed' | 'corrected'
  detail: string
  resultRevision: number
}

export type FinalizationOutcome =
  | { ok: true; applied: boolean; skipped?: undefined }
  | { ok: true; applied: false; skipped: 'practice' }
  | { ok: false; error: string }

function failure(error: string): FinalizationOutcome {
  return { ok: false, error }
}

async function query<T>(
  tool: FinalizationTool,
  collection: string,
  where: Record<string, unknown>,
  userId: string,
  limit = 100,
): Promise<StoredRow<T>[] | null> {
  const result = await tool<QueryActionData<T>>('records.query', { collection, where, limit }, userId)
  if (!result.success) return null
  return result.data.records as StoredRow<T>[]
}

async function profileVisibility(tool: FinalizationTool, userId: string): Promise<ProfileVisibility> {
  const rows = await query<ProfileRowData>(tool, 'profiles', { userId }, userId, 1)
  return rows?.[0]?.data.visibility ?? 'public'
}

export function statsFormatOf(session: RallySession): StatsFormat | null {
  if (session.format === 'Singles') return 'singles'
  if (session.format === 'Doubles') return 'doubles'
  return null
}

export async function writeAudit(
  tool: FinalizationTool,
  sessionId: string,
  actorUserId: string,
  kind: AuditRowData['kind'],
  detail: Record<string, unknown>,
  resultRevision: number,
): Promise<boolean> {
  const result = await tool<MutateActionData>('records.create', {
    collection: 'resultAudits',
    data: {
      sessionId,
      kind,
      detail: JSON.stringify(detail).slice(0, 1000),
      resultRevision,
    },
  }, actorUserId)
  return result.success
}

/**
 * Recompute one player's stats row from their `matchResults` rows and fix
 * it when it disagrees. Returns true when a repair was applied.
 */
export async function reconcilePlayerStats(
  tool: FinalizationTool,
  userId: string,
  format: StatsFormat,
): Promise<boolean> {
  const rows = await query<MatchResultRowData>(tool, 'matchResults', { userId, format }, userId, 500)
  if (rows === null) return false
  const wins = rows.filter((row) => row.data.won === 1).length
  const losses = rows.length - wins
  const existing = await query<PlayerStatsRow>(tool, 'playerStats', { userId, format }, userId, 1)
  if (existing === null) return false
  const current = existing[0]
  const visibility = await profileVisibility(tool, userId)
  if (!current) {
    if (rows.length === 0) return false
    const created = await tool<MutateActionData>('records.create', {
      collection: 'playerStats',
      data: { format, wins, losses, matchesPlayed: rows.length, visibility },
    }, userId)
    return created.success
  }
  const data = current.data
  if (data.wins === wins && data.losses === losses && data.matchesPlayed === rows.length && data.visibility === visibility) {
    return false
  }
  const updated = await tool<MutateActionData>('records.update', {
    collection: 'playerStats',
    recordId: current.recordId,
    data: { wins, losses, matchesPlayed: rows.length, visibility },
  }, userId)
  return updated.success
}

/**
 * Apply a newly finalized result to statistics/history/audit. Idempotent:
 * safe to call again for the same session + revision.
 */
export async function applyFinalization(
  tool: FinalizationTool,
  session: RallySession,
  sessionId: string,
  score: MatchScore,
  actorUserId: string,
  now: () => string = () => new Date().toISOString(),
): Promise<FinalizationOutcome> {
  const format = statsFormatOf(session)
  if (format === null) return { ok: true, applied: false, skipped: 'practice' }
  if (score.winner === null) return failure('Only a completed result can be finalized.')
  const players = score.teams.flat()
  const winnerSide = score.winner
  const finalizedAt = now()

  const existingRows = await query<MatchResultRowData>(tool, 'matchResults', { sessionId }, actorUserId, 10)
  if (existingRows === null) return failure('Finalized results could not be checked.')
  const alreadyApplied = existingRows.some((row) => row.data.resultRevision === score.revision)
  if (alreadyApplied) {
    // Repair path: stats may be missing after a partial failure, and the
    // audit row may not have been written. Reconcile, then ensure audit.
    for (const player of players) {
      await reconcilePlayerStats(tool, player, format)
    }
    const audits = await query<AuditRowData>(tool, 'resultAudits', {
      sessionId,
      kind: 'finalized',
      resultRevision: score.revision,
    }, actorUserId, 1)
    if (audits !== null && audits.length === 0) {
      await writeAudit(tool, sessionId, actorUserId, 'finalized', {
        sets: score.sets,
        winner: winnerSide,
        revision: score.revision,
      }, score.revision)
    }
    return { ok: true, applied: false }
  }

  for (const [index, player] of players.entries()) {
    const won = index < score.teams[0].length ? winnerSide === 0 : winnerSide === 1
    const visibility = await profileVisibility(tool, player)
    const statsRows = await query<PlayerStatsRow>(tool, 'playerStats', { userId: player, format }, player, 1)
    if (statsRows === null) return failure('Player statistics could not be checked.')
    const current = statsRows[0]
    if (!current) {
      const created = await tool<MutateActionData>('records.create', {
        collection: 'playerStats',
        data: {
          format,
          wins: won ? 1 : 0,
          losses: won ? 0 : 1,
          matchesPlayed: 1,
          visibility,
        },
      }, player)
      if (!created.success) return failure('Player statistics could not be saved.')
    } else {
      const updated = await tool<MutateActionData>('records.update', {
        collection: 'playerStats',
        recordId: current.recordId,
        data: {
          wins: current.data.wins + (won ? 1 : 0),
          losses: current.data.losses + (won ? 0 : 1),
          matchesPlayed: current.data.matchesPlayed + 1,
          visibility,
        },
      }, player)
      if (!updated.success) return failure('Player statistics could not be saved.')
    }

    const prior = existingRows.find((row) => row.data.userId === player)
    const rowData = {
      format,
      won: won ? 1 : 0,
      sets: JSON.stringify(score.sets),
      resultRevision: score.revision,
      finalizedAt,
      visibility,
    }
    const saved = prior
      ? await tool<MutateActionData>('records.update', {
        collection: 'matchResults',
        recordId: prior.recordId,
        data: rowData,
      }, player)
      : await tool<MutateActionData>('records.create', {
        collection: 'matchResults',
        data: { sessionId, ...rowData },
      }, player)
    if (!saved.success) return failure('The match result could not be recorded.')
  }

  await writeAudit(tool, sessionId, actorUserId, 'finalized', {
    sets: score.sets,
    winner: winnerSide,
    revision: score.revision,
  }, score.revision)
  return { ok: true, applied: true }
}

/**
 * Subtract a previously finalized outcome from statistics, ahead of a
 * correction. `matchResults` rows are left in place; `applyFinalization`
 * updates them to the new outcome when the corrected result finalizes.
 * Returns false only when the stored rows cannot be read.
 */
export async function reverseFinalization(
  tool: FinalizationTool,
  sessionId: string,
  actorUserId: string,
): Promise<boolean> {
  const rows = await query<MatchResultRowData>(tool, 'matchResults', { sessionId }, actorUserId, 10)
  if (rows === null) return false
  for (const row of rows) {
    const statsRows = await query<PlayerStatsRow>(tool, 'playerStats', {
      userId: row.data.userId,
      format: row.data.format,
    }, row.data.userId, 1)
    const current = statsRows?.[0]
    if (!current) continue
    const won = row.data.won === 1
    await tool<MutateActionData>('records.update', {
      collection: 'playerStats',
      recordId: current.recordId,
      data: {
        wins: Math.max(0, current.data.wins - (won ? 1 : 0)),
        losses: Math.max(0, current.data.losses - (won ? 0 : 1)),
        matchesPlayed: Math.max(0, current.data.matchesPlayed - 1),
      },
    }, row.data.userId)
  }
  return true
}
