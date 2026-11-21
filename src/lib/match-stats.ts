/**
 * Player match statistics — pure computation over finalized result rows.
 *
 * Eligibility rule (C02/C09/C12): only rows in the `matchResults`
 * collection count. A row is written only when a result finalizes inside
 * the RallyCommandRoom (every recorded participant approved), so by
 * construction every row here is an eligible finalized result. Disputed
 * results are never written, corrections update the row in place (see
 * result-finalization.ts), and withdrawals after selection do not remove
 * a finalized result — the recorded participants are what counts.
 *
 * Row status (issue #23 semantics): a host correction moves the session
 * score to a newer revision awaiting fresh approval. The stored row is
 * NOT deleted and its old outcome is NOT counted; instead the history
 * surfaces the corrected outcome as `status: 'pending'` (visible, not
 * counted) until re-approval finalizes it in place, when it becomes
 * 'final' again. A dispute puts rows in `status: 'disputed'`, hidden from
 * both statistics and history until a correction reopens them as pending.
 * `summarizePlayerStats` counts final rows only.
 *
 * Where the status lives: the serialized command room maintains it at
 * write time (finalization writes 'final'; a correction flips rows to
 * 'pending' and a dispute to 'disputed' before the session score commits),
 * so the read path can trust the stored outcome for 'final' rows without
 * fetching each session. The read path never trusts a status it cannot
 * classify: a missing status means a pre-migration row, which was written
 * only on finalization and counts as 'final'; any other value hides the
 * row (fail closed).
 *
 * Singles and doubles are kept strictly separate (C10): a `format`
 * parameter is required everywhere, and no function ever mixes formats.
 * Practice matches are never written to `matchResults` and so never
 * affect statistics.
 *
 * Provisional status (C11/D03): fewer than PROVISIONAL_MATCH_THRESHOLD
 * matches is provisional. The threshold is a single named constant so a
 * future rating track can change it in one place.
 */

import type { ProfileVisibility } from './profile.js'

export type StatsFormat = 'singles' | 'doubles'

export const PROVISIONAL_MATCH_THRESHOLD = 5

/** One row of the `matchResults` collection (finalized result, per player). */
export interface MatchResultRow {
  recordId: string
  sessionId: string
  userId: string
  format: StatsFormat
  /** Stored as 0/1 in the record; decoded here. */
  won: boolean
  sets: Array<[number, number]>
  resultRevision: number
  finalizedAt: string
  visibility: ProfileVisibility
  /**
   * 'final' — the row's outcome is verified and counts in statistics.
   * 'pending' — the session's committed score moved to a newer revision
   * (a host correction awaiting fresh approval); the match stays visible
   * in history but must NOT count in statistics until the corrected result
   * finalizes (issue #23 semantics).
   */
  status: 'final' | 'pending'
}

/** Write-side row status, including the hidden 'disputed' and 'cancelled' states (never surfaced as a MatchResultRow). 'cancelled' is the migration-F4 write-side form: the room flips a session's rows to it at cancel time so a finalized result on a later-cancelled session stops counting without a per-row session read. */
export type MatchResultStatus = 'final' | 'pending' | 'disputed' | 'cancelled'

/**
 * Normalize a stored row status. A missing status means a pre-migration
 * row, written only on finalization, so it counts as 'final'. Any value
 * outside the known set hides the row (fail closed) — the read path must
 * never count an outcome it cannot classify.
 */
export function normalizeResultStatus(value: unknown): MatchResultStatus | null {
  if (value === undefined || value === null) return 'final'
  if (value === 'final' || value === 'pending' || value === 'disputed' || value === 'cancelled') return value
  return null
}

/**
 * Parse a stored `sets` value. The column uses the SDK's `json`
 * interpretation, so production reads return the decoded array; older or
 * hand-written rows may still carry the raw JSON string. Anything else
 * (unparseable text, wrong shape) returns null and the row is dropped —
 * corrupt data must never brick the call (D1/F6).
 */
export function parseStoredSets(value: unknown): Array<[number, number]> | null {
  const parsed: unknown = typeof value === 'string'
    ? (() => { try { return JSON.parse(value) } catch { return null } })()
    : value
  if (!Array.isArray(parsed)) return null
  const sets: Array<[number, number]> = []
  for (const entry of parsed) {
    if (!Array.isArray(entry) || entry.length !== 2
      || typeof entry[0] !== 'number' || typeof entry[1] !== 'number'
      || !Number.isFinite(entry[0]) || !Number.isFinite(entry[1])) return null
    sets.push([entry[0], entry[1]])
  }
  return sets
}

export interface PlayerStatsSummary {
  userId: string
  format: StatsFormat
  wins: number
  losses: number
  matchesPlayed: number
  /** Null when no matches have been played. */
  winRate: number | null
  /** True when matchesPlayed < PROVISIONAL_MATCH_THRESHOLD. */
  provisional: boolean
  visibility: ProfileVisibility
}

export interface MatchHistoryEntry {
  sessionId: string
  format: StatsFormat
  won: boolean
  sets: Array<[number, number]>
  finalizedAt: string
  resultRevision: number
  /** 'pending' entries show the corrected (unapproved) outcome; 'final' entries are verified. */
  status: 'final' | 'pending'
}

/** Summarize one player's rows for one format. Rows of other formats are ignored. Pending (unconfirmed) rows never count. */
export function summarizePlayerStats(
  rows: readonly MatchResultRow[],
  userId: string,
  format: StatsFormat,
  visibility: ProfileVisibility,
): PlayerStatsSummary {
  const own = rows.filter((row) => row.userId === userId && row.format === format && row.status === 'final')
  const wins = own.filter((row) => row.won).length
  const losses = own.length - wins
  return {
    userId,
    format,
    wins,
    losses,
    matchesPlayed: own.length,
    winRate: own.length === 0 ? null : wins / own.length,
    provisional: own.length < PROVISIONAL_MATCH_THRESHOLD,
    visibility,
  }
}

/**
 * Build one player's match history, newest first. The caller supplies rows
 * already filtered to that player (a `records.query` by `userId`); this
 * function only orders and projects them. Pending entries are included
 * with their status so the UI can show a corrected result as awaiting
 * approval instead of hiding the match entirely.
 */
export function buildMatchHistory(rows: readonly MatchResultRow[]): MatchHistoryEntry[] {
  return [...rows]
    .sort((a, b) => (a.finalizedAt < b.finalizedAt ? 1 : a.finalizedAt > b.finalizedAt ? -1 : 0))
    .map((row) => ({
      sessionId: row.sessionId,
      format: row.format,
      won: row.won,
      sets: row.sets,
      finalizedAt: row.finalizedAt,
      resultRevision: row.resultRevision,
      status: row.status,
    }))
}

/**
 * Public-statistics listing filter (C14). Private players are removed from
 * any public listing. This is a second layer: the collections themselves
 * also enforce it at the record layer via `visibilityField` + read
 * 'published', so a private row is unreadable to other members even
 * through direct record reads.
 */
export function filterPublicStats<T extends { userId: string; visibility: ProfileVisibility }>(
  summaries: readonly T[],
): T[] {
  return summaries.filter((summary) => summary.visibility === 'public')
}

/** Visibility a stats/results row should carry, from the player's profile. */
export function statsVisibilityFor(profileVisibility: ProfileVisibility | null): ProfileVisibility {
  return profileVisibility ?? 'public'
}
