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
 * Singles and doubles are kept strictly separate (C10): a `format`
 * parameter is required everywhere, and no function ever mixes formats.
 * Practice matches are never written to `matchResults` and so never
 * affect statistics.
 *
 * Pending rows (issue #23 semantics): a host correction moves the
 * session score to a newer revision awaiting fresh approval. The stored
 * row is NOT deleted and its old outcome is NOT counted; instead the
 * history surfaces the corrected outcome as `status: 'pending'` (visible,
 * not counted) until re-approval finalizes it in place, when it becomes
 * 'final' again. `summarizePlayerStats` counts final rows only.
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
   * 'final' — the row's outcome is verified against the session's committed
   * score and counts in statistics. 'pending' — the session's committed
   * score moved to a newer revision (a host correction awaiting fresh
   * approval); the match stays visible in history but must NOT count in
   * statistics until the corrected result finalizes (issue #23 semantics).
   */
  status: 'final' | 'pending'
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
