import type { ActionHandler, ActionResult, GetActionData, MutateActionData, QueryActionData } from 'deepspace/worker'
import type { RallyRSVP, RallySession, RSVPStatus } from '../lib/rally.js'
import {
  validateScoreboardInput,
  type MatchScoreboard,
  type ScoreboardCurrent,
  type ScoreboardInput,
  type ScoreboardStatus,
} from '../lib/scoreboard.js'
import type { Env } from '../../worker.js'

type RallyCommand =
  | { operation: 'rsvp'; sessionId: string; status: RSVPStatus; userId: string }
  | { operation: 'cancel'; sessionId: string; userId: string }
  | {
    operation: 'scoreboard'
    sessionId: string
    userId: string
    input: ScoreboardInput
    expectedVersion: number
    correction: boolean
  }

type RallyCommandResult = ActionResult<{ recordId: string }>
type RecordTool = <T>(tool: string, params: Record<string, unknown>, userId: string) => Promise<ActionResult<T>>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseSetScore(value: unknown): { a: number; b: number } | null {
  if (!isRecord(value)) return null
  return typeof value.a === 'number' && typeof value.b === 'number'
    ? { a: value.a, b: value.b }
    : null
}

function parseScoreboardInput(value: Record<string, unknown>): ScoreboardInput | null {
  if (typeof value.teamAName !== 'string' || typeof value.teamBName !== 'string') return null
  const status = value.status
  if (status !== 'not_started' && status !== 'in_progress' && status !== 'final') return null
  if (!Array.isArray(value.sets)) return null
  const sets: { a: number; b: number }[] = []
  for (const raw of value.sets) {
    const set = parseSetScore(raw)
    if (!set) return null
    sets.push(set)
  }
  let matchTiebreak: { a: number; b: number } | null = null
  if (value.matchTiebreak !== null && value.matchTiebreak !== undefined) {
    matchTiebreak = parseSetScore(value.matchTiebreak)
    if (!matchTiebreak) return null
  }
  return {
    teamAName: value.teamAName,
    teamBName: value.teamBName,
    status: status as ScoreboardStatus,
    sets,
    matchTiebreak,
  }
}

function parseCommand(value: unknown): RallyCommand | null {
  if (!isRecord(value) || typeof value.userId !== 'string' || !value.userId ||
      typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 200) {
    return null
  }

  if (value.operation === 'cancel') {
    return { operation: value.operation, sessionId: value.sessionId, userId: value.userId }
  }
  if (value.operation === 'rsvp' && (value.status === 'going' || value.status === 'maybe')) {
    return { operation: value.operation, sessionId: value.sessionId, status: value.status, userId: value.userId }
  }
  if (value.operation === 'scoreboard') {
    const input = parseScoreboardInput(value)
    if (!input) return null
    if (typeof value.expectedVersion !== 'number' || !Number.isInteger(value.expectedVersion) || value.expectedVersion < 0) return null
    if (typeof value.correction !== 'boolean') return null
    return {
      operation: 'scoreboard',
      sessionId: value.sessionId,
      userId: value.userId,
      input,
      expectedVersion: value.expectedVersion,
      correction: value.correction,
    }
  }
  return null
}

function failure(error: string): RallyCommandResult {
  return { success: false, error }
}

async function applyCommand(command: RallyCommand, tool: RecordTool): Promise<RallyCommandResult> {
  const sessionResult = await tool<GetActionData<RallySession>>(
    'records.get',
    { collection: 'sessions', recordId: command.sessionId },
    command.userId,
  )
  if (!sessionResult.success) return failure('This session is unavailable.')

  const session = sessionResult.data.record.data
  if (command.operation === 'cancel') {
    if (session.hostId !== command.userId) return failure('Only the session host can cancel it.')
    if (session.status === 'cancelled') return { success: true, data: { recordId: command.sessionId } }
    if (session.status !== 'open') return failure('Only an open session can be cancelled.')

    const result = await tool<MutateActionData>(
      'records.update',
      { collection: 'sessions', recordId: command.sessionId, data: { status: 'cancelled' } },
      command.userId,
    )
    return result.success
      ? { success: true, data: { recordId: command.sessionId } }
      : failure('The session could not be cancelled.')
  }

  if (command.operation === 'scoreboard') {
    if (session.hostId !== command.userId) return failure('Only the session host can update the scoreboard.')
    if (session.status === 'cancelled') return failure('This session was cancelled, so its scoreboard is closed.')
    if (session.status !== 'open') return failure('This session is unavailable.')

    const existingResult = await tool<QueryActionData<MatchScoreboard>>(
      'records.query',
      { collection: 'matchScores', where: { sessionId: command.sessionId }, limit: 1 },
      command.userId,
    )
    if (!existingResult.success) return failure('The current score could not be checked.')

    const existing = existingResult.data.records[0]
    const current: ScoreboardCurrent | null = existing
      ? {
        status: existing.data.status,
        version: existing.data.version,
        teamAName: existing.data.teamAName,
        teamBName: existing.data.teamBName,
        sets: Array.isArray(existing.data.sets) ? existing.data.sets : [],
        matchTiebreak: existing.data.matchTiebreak ?? null,
      }
      : null

    // Optimistic concurrency: a write must carry the version it read.
    // Two simultaneous edits are serialised by this room's queue, so the
    // second one sees the first one's version and gets a conflict — a
    // surfaced error, never a silent overwrite.
    const expected = current ? current.version : 0
    if (command.expectedVersion !== expected) {
      return failure('Conflict: This score was updated by someone else. Your view now shows the latest score — review it and save again if needed.')
    }

    const problem = validateScoreboardInput(command.input, current, command.correction)
    if (problem) return failure(problem)

    const data = {
      sessionId: command.sessionId,
      teamAName: command.input.teamAName.trim(),
      teamBName: command.input.teamBName.trim(),
      status: command.input.status,
      sets: command.input.sets,
      matchTiebreak: command.input.matchTiebreak,
      updatedBy: command.userId,
    }

    // Idempotent re-save: an identical payload is a success with no version bump.
    if (current && data.teamAName === current.teamAName && data.teamBName === current.teamBName &&
        data.status === current.status && data.matchTiebreak?.a === current.matchTiebreak?.a &&
        data.matchTiebreak?.b === current.matchTiebreak?.b && data.sets.length === current.sets.length &&
        data.sets.every((set, i) => set.a === current.sets[i]?.a && set.b === current.sets[i]?.b)) {
      return { success: true, data: { recordId: existing.recordId } }
    }

    const result = existing
      ? await tool<MutateActionData>(
        'records.update',
        { collection: 'matchScores', recordId: existing.recordId, data: { ...data, version: existing.data.version + 1 } },
        command.userId,
      )
      : await tool<MutateActionData>(
        'records.create',
        { collection: 'matchScores', data: { ...data, version: 1 } },
        command.userId,
      )
    return result.success
      ? { success: true, data: { recordId: result.data.recordId } }
      : failure('The score could not be saved.')
  }

  if (session.status !== 'open') return failure('This session is not open for responses.')

  const existingResult = await tool<QueryActionData<RallyRSVP>>(
    'records.query',
    {
      collection: 'rsvps',
      where: { sessionId: command.sessionId, userId: command.userId },
      limit: 1,
    },
    command.userId,
  )
  if (!existingResult.success) return failure('Your existing RSVP could not be checked.')

  const existing = existingResult.data.records[0]
  const result = existing
    ? await tool<MutateActionData>(
      'records.update',
      { collection: 'rsvps', recordId: existing.recordId, data: { status: command.status } },
      command.userId,
    )
    : await tool<MutateActionData>(
      'records.create',
      { collection: 'rsvps', data: { sessionId: command.sessionId, status: command.status } },
      command.userId,
    )

  return result.success
    ? { success: true, data: { recordId: result.data.recordId } }
    : failure('Your RSVP could not be saved.')
}

export class RallyCommandRoom {
  private queue: Promise<void> = Promise.resolve()

  constructor(
    _state: DurableObjectState,
    private readonly env: Env,
  ) {}

  fetch(request: Request): Promise<Response> {
    const result = this.queue.then(() => this.handle(request))
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private async handle(request: Request): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/rally-command') {
      return Response.json(failure('Invalid rally command request.'), { status: 400 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch (cause) {
      if (cause instanceof SyntaxError) {
        return Response.json(failure('Invalid rally command request.'), { status: 400 })
      }
      throw cause
    }

    const command = parseCommand(body)
    if (!command) return Response.json(failure('Invalid rally command.'), { status: 400 })

    const recordRoom = this.env.RECORD_ROOMS.get(
      this.env.RECORD_ROOMS.idFromName(`app:${this.env.DEEPSPACE_APP_ID}`),
    )
    const tool: RecordTool = async <T>(
      name: string,
      params: Record<string, unknown>,
      userId: string,
    ) => {
      const response = await recordRoom.fetch(
        new Request('https://internal/api/tools/execute', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-User-Id': userId,
            'X-App-Action': 'true',
          },
          body: JSON.stringify({ tool: name, params }),
        }),
      )
      return await response.json() as ActionResult<T>
    }

    return Response.json(await applyCommand(command, tool))
  }
}

export const rallyCommandAction: ActionHandler<Env> = async ({ userId, params, tools, env }) => {
  // Pass the whole body through: parseCommand picks only the fields each
  // operation needs (rsvp/cancel use `status`; scoreboard uses its own
  // team/set/tiebreak/version fields). `userId` always comes from the
  // verified action context, never from the body.
  const command = parseCommand({ ...params, userId })
  if (!command) return failure('Invalid rally command.')

  const sessionResult = await tools.get('sessions', command.sessionId)
  if (!sessionResult.success) return failure('This session is unavailable.')

  const room = env.RALLY_COMMAND_ROOMS.get(
    env.RALLY_COMMAND_ROOMS.idFromName(`rally:${env.DEEPSPACE_APP_ID}:${command.sessionId}`),
  )
  const response = await room.fetch(
    new Request('https://internal/rally-command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    }),
  )
  const result: unknown = await response.json()
  if (
    isRecord(result) &&
    ((result.success === true && isRecord(result.data) && typeof result.data.recordId === 'string') ||
      (result.success === false && typeof result.error === 'string'))
  ) {
    return result as RallyCommandResult
  }
  return failure('The rally command returned an invalid response.')
}
