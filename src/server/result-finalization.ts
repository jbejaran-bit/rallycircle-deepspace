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
  return rows?.[0]?.data.visibility ?? 'private'
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
  const existing = await query<AuditRowData>(tool, 'resultAudits', { sessionId, kind, resultRevision }, actorUserId, 1)
  if (!existing) return false
  if (existing.length > 0) return true
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

/** Prepare the player index and audit before the scoreboard revision commits. */
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
  const applied = players.some(player => !existingRows.some(row =>
    row.data.userId === player && row.data.resultRevision === score.revision,
  ))

  for (const [index, player] of players.entries()) {
    const prior = existingRows.find(row => row.data.userId === player)
    if (prior?.data.resultRevision === score.revision) continue
    const won = index < score.teams[0].length ? winnerSide === 0 : winnerSide === 1
    const data = {
      won: won ? 1 : 0,
      sets: JSON.stringify(score.sets),
      resultRevision: score.revision,
      finalizedAt,
      visibility: await profileVisibility(tool, player),
    }
    const saved = prior
      ? await tool<MutateActionData>('records.update', {
        collection: 'matchResults', recordId: prior.recordId, data,
      }, player)
      : await tool<MutateActionData>('records.create', {
        collection: 'matchResults', data: { sessionId, format, ...data },
      }, player)
    if (!saved.success) return failure('The match result could not be recorded.')
  }

  const audited = await writeAudit(tool, sessionId, actorUserId, 'finalized', {
    sets: score.sets, winner: winnerSide, revision: score.revision,
  }, score.revision)
  if (!audited) return failure('The finalized result could not be audited.')
  return { ok: true, applied }
}
