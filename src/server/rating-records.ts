/**
 * RallyCircle Rating — persistent records (algorithm version 1).
 *
 * Two collections, both server-written only (direct client create/update/
 * delete closed for every role — the same posture as `rsvps`):
 *
 * - `playerRatings`: one row per (player, format) — the current rating,
 *   matches played, provisional flag, algorithm version, last result id.
 *   A cache of the latest history entry, not the source of truth.
 * - `ratingChanges`: append-only history. One row per (result, player).
 *   `uniqueOn: ['resultId', 'playerId']` makes applying the same result
 *   twice a no-op at the schema level too.
 *
 * EXPERIMENTAL: every `playerRatings` row carries `status: 'experimental'`.
 * Ratings never write into any release-candidate statistics path (none
 * exists in the base). See docs/RATING_SPEC.md.
 *
 * The store applier takes the same record-tool function shape the
 * RallyCommandRoom uses (`records.query/create/update` via the tools API
 * with `X-App-Action`), so the real integration passes the command room's
 * tool straight in. Tests use an in-memory mock of that function.
 */

import type { CollectionSchema } from 'deepspace/schema'
import type { ActionResult, GetActionData, MutateActionData, QueryActionData } from 'deepspace/worker'
import {
  RATING_ALGORITHM_VERSION,
  applyFinalizedResult,
  clampRating,
  isProvisional,
  resultIdFor,
  type FinalizedResultInput,
  type PlayerRatingState,
  type RatingChange,
  type RatingFormat,
} from '../lib/rating.js'
import { readMatchScore, resultStatus, type MatchScore } from '../lib/rally-score.js'
import type { RallySession } from '../lib/rally.js'

export const RATING_STATUS_EXPERIMENTAL = 'experimental'

export const playerRatingsSchema: CollectionSchema = {
  name: 'playerRatings',
  columns: [
    { name: 'playerId', storage: 'text', interpretation: 'plain', required: true, immutable: true, userBound: true },
    { name: 'format', storage: 'text', interpretation: { kind: 'select', options: ['Singles', 'Doubles'] }, required: true, immutable: true },
    { name: 'rating', storage: 'number', interpretation: 'plain', required: true },
    { name: 'matchesPlayed', storage: 'number', interpretation: 'plain', required: true },
    // Stored as 0/1: schema columns are number|text only (no boolean storage).
    { name: 'provisional', storage: 'number', interpretation: 'plain', required: true },
    { name: 'algorithmVersion', storage: 'number', interpretation: 'plain', required: true },
    { name: 'lastResultId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'status', storage: 'text', interpretation: 'plain', required: true, default: RATING_STATUS_EXPERIMENTAL },
  ],
  uniqueOn: ['playerId', 'format'],
  ownerField: 'playerId',
  permissions: {
    '*': { read: false, create: false, update: false, delete: false },
    // Ratings are community-visible (leaderboard/display), like match
    // results. Track B's privacy model may restrict this later; if player
    // profiles go private, rating visibility must follow.
    member: { read: true, create: false, update: false, delete: false },
    admin: { read: true, create: false, update: false, delete: false },
  },
}

export const ratingChangesSchema: CollectionSchema = {
  name: 'ratingChanges',
  columns: [
    { name: 'resultId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'playerId', storage: 'text', interpretation: 'plain', required: true, immutable: true, userBound: true },
    { name: 'format', storage: 'text', interpretation: { kind: 'select', options: ['Singles', 'Doubles'] }, required: true, immutable: true },
    { name: 'algorithmVersion', storage: 'number', interpretation: 'plain', required: true, immutable: true },
    { name: 'before', storage: 'number', interpretation: 'plain', required: true, immutable: true },
    { name: 'after', storage: 'number', interpretation: 'plain', required: true, immutable: true },
    { name: 'delta', storage: 'number', interpretation: 'plain', required: true, immutable: true },
    { name: 'reason', storage: 'text', interpretation: { kind: 'select', options: ['result', 'reversal'] }, required: true, immutable: true },
    { name: 'explanation', storage: 'text', interpretation: 'plain', required: true, immutable: true, maxLength: 400 },
    // JSON array of opponent player ids (repeat-opponent counting + audit).
    { name: 'opponentIds', storage: 'text', interpretation: { kind: 'json' }, required: true, immutable: true },
    { name: 'matchesPlayedAfter', storage: 'number', interpretation: 'plain', required: true, immutable: true },
  ],
  uniqueOn: ['resultId', 'playerId'],
  ownerField: 'playerId',
  permissions: {
    '*': { read: false, create: false, update: false, delete: false },
    member: { read: true, create: false, update: false, delete: false },
    admin: { read: true, create: false, update: false, delete: false },
  },
}

export interface PlayerRatingRecord {
  recordId: string
  playerId: string
  format: RatingFormat
  rating: number
  matchesPlayed: number
  provisional: boolean
  algorithmVersion: number
  lastResultId: string
  status: string
}

export interface RatingChangeRecord {
  recordId: string
  resultId: string
  playerId: string
  format: RatingFormat
  algorithmVersion: number
  before: number
  after: number
  delta: number
  reason: 'result' | 'reversal'
  explanation: string
  opponentIds: string[]
  matchesPlayedAfter: number
}

export type RatingRecordTool = <T>(
  tool: string,
  params: Record<string, unknown>,
  userId: string,
) => Promise<ActionResult<T>>

interface RecordEnvelope<T> {
  recordId: string
  data: T
}

type PlayerRatingRow = Omit<PlayerRatingRecord, 'recordId' | 'provisional'> & { provisional: number }
type RatingChangeRow = Omit<RatingChangeRecord, 'recordId' | 'opponentIds'> & { opponentIds: string }

function toPlayerRating(record: RecordEnvelope<PlayerRatingRow>): PlayerRatingRecord {
  return { recordId: record.recordId, ...record.data, provisional: record.data.provisional === 1 }
}

function toChange(record: RecordEnvelope<RatingChangeRow>): RatingChangeRecord {
  let opponentIds: string[] = []
  try {
    const parsed: unknown = JSON.parse(record.data.opponentIds)
    if (Array.isArray(parsed)) opponentIds = parsed.filter((id): id is string => typeof id === 'string')
  } catch {
    opponentIds = []
  }
  return { recordId: record.recordId, ...record.data, opponentIds }
}

/**
 * Minimal finalized-results read helper (shared dependency for Track C).
 * Scans session records and returns one input per FINALIZED match score:
 * winner set, not disputed, every recorded participant approved
 * (`resultStatus(score) === 'final'`). Proposed, partially confirmed,
 * disputed, and in-progress results are ignored. Practice sessions never
 * have a match score and are ignored. Cancellation does NOT un-finalize a
 * result: the command room rejects score edits on cancelled sessions, so a
 * final result on a cancelled session could only have been finalized before
 * cancellation — a real played match — and it still counts. If Track C
 * decides cancelled sessions void results, filter there, not here.
 * This is a scan over session records; at RallyCircle's scale that is
 * acceptable — if volume ever grows, index finalized results into their
 * own collection instead (Track C).
 */
export function finalizedResultsFromSessions(
  sessions: readonly { recordId: string; data: RallySession }[],
): FinalizedResultInput[] {
  const results: FinalizedResultInput[] = []
  for (const session of sessions) {
    const score: MatchScore | null = readMatchScore(session.data.matchScore)
    if (!score || resultStatus(score) !== 'final' || score.winner === null) continue
    const format = session.data.format
    if (format !== 'Singles' && format !== 'Doubles') continue
    results.push({
      resultId: resultIdFor(session.recordId, score.revision),
      sessionId: session.recordId,
      format,
      teams: score.teams,
      winner: score.winner,
    })
  }
  return results
}

/** Count prior finalized matches in which `playerId` faced `opponentId`. */
export function repeatCountFromHistory(
  history: readonly RatingChangeRecord[],
  playerId: string,
  opponentId: string,
): number {
  return history.filter(
    change => change.playerId === playerId && change.opponentIds.includes(opponentId),
  ).length
}

export interface ApplyRatingOutcome {
  applied: boolean
  /** Per-player outcomes; empty when the result was already applied. */
  changes: RatingChange[]
  skipped: string[]
  error?: string
}

/**
 * Apply one finalized result to the rating store, idempotently.
 * For each player: skip if a `ratingChanges` row already exists for
 * (resultId, playerId); otherwise compute the pure-engine update, append
 * the change record, and upsert the player's current rating row. The
 * caller must only pass results from `finalizedResultsFromSessions` (or
 * otherwise verified final); this function re-validates the input shape
 * but cannot re-check approvals — that is the read helper's job.
 *
 * NOTE: not wired into any write path yet. The intended trigger is the
 * command room's `reviewResult` branch, right after a review makes a
 * result final (see PATCHES.md). Until wired, call this from a server
 * action/job only — never from client code.
 */
export async function applyFinalizedResultToStore(
  input: FinalizedResultInput,
  tool: RatingRecordTool,
  systemUserId: string,
): Promise<ApplyRatingOutcome> {
  const query = <T>(collection: string, where: Record<string, unknown>, limit = 100) =>
    tool<QueryActionData<T>>('records.query', { collection, where, limit }, systemUserId)

  const players = [...input.teams[0], ...input.teams[1]]
  const states = new Map<string, PlayerRatingState>()
  const existingRatings = new Map<string, RecordEnvelope<PlayerRatingRow>>()
  for (const playerId of players) {
    const ratingResult = await query<PlayerRatingRow>('playerRatings', { playerId, format: input.format }, 1)
    if (!ratingResult.success) return { applied: false, changes: [], skipped: [], error: 'Current ratings could not be read.' }
    const row = ratingResult.data.records[0]
    if (row) {
      existingRatings.set(playerId, row)
      states.set(playerId, { playerId, rating: row.data.rating, matchesPlayed: row.data.matchesPlayed })
    }
  }

  // Repeat-opponent counts come from the player's own change history.
  const repeatCounts = new Map<string, number>()
  for (const side of [0, 1] as const) {
    // The opposing team only — not the player's own partner. A prior
    // result counts if the player faced at least one member of this
    // opposing team in it (doubles) or that exact opponent (singles).
    const opponents = input.teams[side === 0 ? 1 : 0]
    for (const playerId of input.teams[side]) {
      const historyResult = await query<RatingChangeRow>('ratingChanges', { playerId, format: input.format }, 100)
      if (!historyResult.success) return { applied: false, changes: [], skipped: [], error: 'Rating history could not be read.' }
      const history = historyResult.data.records.map(toChange)
      const priorResults = new Map<string, RatingChangeRecord>()
      for (const change of history) {
        if (change.opponentIds.some(id => opponents.includes(id))) priorResults.set(change.resultId, change)
      }
      repeatCounts.set(playerId, priorResults.size)
    }
  }

  const outcome = applyFinalizedResult(input, states, repeatCounts)
  if (!outcome.ok) return { applied: false, changes: [], skipped: [], error: outcome.error }

  const changes: RatingChange[] = []
  const skipped: string[] = []
  for (const change of outcome.changes) {
    const already = await query<RatingChangeRow>('ratingChanges', {
      resultId: input.resultId, playerId: change.playerId,
    }, 1)
    if (!already.success) return { applied: false, changes, skipped, error: 'Existing rating changes could not be checked.' }
    if (already.data.records[0]) {
      skipped.push(change.playerId)
      continue
    }
    const created = await tool<MutateActionData>('records.create', {
      collection: 'ratingChanges',
      data: {
        resultId: input.resultId,
        playerId: change.playerId,
        format: change.format,
        algorithmVersion: RATING_ALGORITHM_VERSION,
        before: change.before,
        after: change.after,
        delta: change.delta,
        reason: 'result',
        explanation: change.explanation,
        opponentIds: JSON.stringify(change.opponentIds),
        matchesPlayedAfter: change.matchesPlayedAfter,
      },
    }, change.playerId)
    if (!created.success) return { applied: false, changes, skipped, error: `Rating change for ${change.playerId} could not be saved.` }
    const existing = existingRatings.get(change.playerId)
    const ratingData = {
      playerId: change.playerId,
      format: change.format,
      rating: change.after,
      matchesPlayed: change.matchesPlayedAfter,
      provisional: change.provisionalAfter ? 1 : 0,
      algorithmVersion: RATING_ALGORITHM_VERSION,
      lastResultId: input.resultId,
      status: RATING_STATUS_EXPERIMENTAL,
    }
    const saved = existing
      ? await tool<MutateActionData>('records.update', {
          collection: 'playerRatings', recordId: existing.recordId, data: ratingData,
        }, change.playerId)
      : await tool<MutateActionData>('records.create', {
          collection: 'playerRatings', data: ratingData,
        }, change.playerId)
    if (!saved.success) return { applied: false, changes, skipped, error: `Current rating for ${change.playerId} could not be saved.` }
    changes.push(change)
  }
  return { applied: changes.length > 0, changes, skipped }
}

export interface ReverseRatingOutcome {
  reversed: boolean
  changes: RatingChange[]
  error?: string
}

/**
 * Reverse the rating effect of a finalized result that was later corrected
 * or invalidated. Appends `reason: 'reversal'` change records with negated
 * deltas and updates current ratings; history is never edited. Reversing
 * an already-reversed result is a no-op. The base has no correction
 * workflow yet — this is the API Track C calls when one lands.
 */
export async function reverseRatingEffect(
  resultId: string,
  tool: RatingRecordTool,
  systemUserId: string,
): Promise<ReverseRatingOutcome> {
  const query = <T>(collection: string, where: Record<string, unknown>, limit = 100) =>
    tool<QueryActionData<T>>('records.query', { collection, where, limit }, systemUserId)

  const originalResult = await query<RatingChangeRow>('ratingChanges', { resultId, reason: 'result' }, 100)
  if (!originalResult.success) return { reversed: false, changes: [], error: 'Rating changes could not be read.' }
  const originals = originalResult.data.records.map(toChange)
  if (originals.length === 0) return { reversed: false, changes: [], error: 'No rating effect exists for this result.' }

  const changes: RatingChange[] = []
  for (const original of originals) {
    const reversalCheck = await query<RatingChangeRow>('ratingChanges', {
      resultId, playerId: original.playerId, reason: 'reversal',
    }, 1)
    if (!reversalCheck.success) return { reversed: false, changes, error: 'Existing reversals could not be checked.' }
    if (reversalCheck.data.records[0]) continue
    // Apply the NEGATED delta to the CURRENT rating, not the old value:
    // the player may have played more matches since the original result,
    // so restoring `original.before` would erase those later results.
    const currentResult = await query<PlayerRatingRow>('playerRatings', {
      playerId: original.playerId, format: original.format,
    }, 1)
    if (!currentResult.success || !currentResult.data.records[0]) {
      return { reversed: false, changes, error: `Current rating for ${original.playerId} could not be read.` }
    }
    const current = currentResult.data.records[0]
    const after = clampRating(current.data.rating - original.delta)
    const matchesPlayedAfter = Math.max(0, current.data.matchesPlayed - 1)
    const reversed: RatingChange = {
      playerId: original.playerId,
      format: original.format,
      before: current.data.rating,
      after,
      delta: after - current.data.rating,
      k: 0,
      expected: 0,
      opponentIds: original.opponentIds,
      matchesPlayedAfter,
      provisionalAfter: isProvisional(matchesPlayedAfter),
      explanation: `Reversal of ${original.explanation}`,
    }
    const created = await tool<MutateActionData>('records.create', {
      collection: 'ratingChanges',
      data: {
        resultId,
        playerId: reversed.playerId,
        format: reversed.format,
        algorithmVersion: RATING_ALGORITHM_VERSION,
        before: reversed.before,
        after: reversed.after,
        delta: reversed.delta,
        reason: 'reversal',
        explanation: reversed.explanation,
        opponentIds: JSON.stringify(reversed.opponentIds),
        matchesPlayedAfter: reversed.matchesPlayedAfter,
      },
    }, reversed.playerId)
    if (!created.success) return { reversed: false, changes, error: `Reversal for ${reversed.playerId} could not be saved.` }
    const saved = await tool<MutateActionData>('records.update', {
      collection: 'playerRatings',
      recordId: current.recordId,
      data: {
        rating: reversed.after,
        matchesPlayed: reversed.matchesPlayedAfter,
        provisional: reversed.provisionalAfter ? 1 : 0,
        algorithmVersion: RATING_ALGORITHM_VERSION,
        lastResultId: resultId,
      },
    }, reversed.playerId)
    if (!saved.success) return { reversed: false, changes, error: `Current rating for ${reversed.playerId} could not be updated.` }
    changes.push(reversed)
  }
  return { reversed: changes.length > 0, changes }
}

/** Read a player's current rating row (typed, provisional as boolean). */
export async function readPlayerRating(
  playerId: string,
  format: RatingFormat,
  tool: RatingRecordTool,
  systemUserId: string,
): Promise<PlayerRatingRecord | null> {
  const result = await tool<QueryActionData<PlayerRatingRow>>('records.query', {
    collection: 'playerRatings', where: { playerId, format }, limit: 1,
  }, systemUserId)
  if (!result.success || !result.data.records[0]) return null
  return toPlayerRating(result.data.records[0])
}
