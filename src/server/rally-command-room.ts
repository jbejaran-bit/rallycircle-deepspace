import type { ActionHandler, ActionResult, GetActionData, MutateActionData, QueryActionData } from 'deepspace/worker'
import { validCapacity, type RallyRSVP, type RallySession, type RSVPStatus } from '../lib/rally.js'
import { awardPoint, createMatchScore, readMatchScore, scoreEditSchema } from '../lib/rally-score.js'
import type { z } from 'zod'
import type { Env } from '../../worker.js'

type ScoreEdit = z.infer<typeof scoreEditSchema> & { sessionId: string; userId: string }

type RallyCommand =
  | ScoreEdit
  | { operation: 'rsvp'; sessionId: string; status: RSVPStatus; userId: string }
  | { operation: 'cancel'; sessionId: string; userId: string }

type RallyCommandResult = ActionResult<{ recordId: string }>
type RecordTool = <T>(tool: string, params: Record<string, unknown>, userId: string) => Promise<ActionResult<T>>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
  const scoreEdit = scoreEditSchema.safeParse(value)
  return scoreEdit.success ? { ...scoreEdit.data, sessionId: value.sessionId, userId: value.userId } : null
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

  if (command.operation === 'startMatch' || command.operation === 'scorePoint') {
    return applyScoreEdit(command, session, tool)
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
  // All transitions that can increase occupancy go through this session's
  // queue. A concurrent self-withdrawal can only decrease occupancy.
  if (session.capacity != null && command.status === 'going' && existing?.data.status !== 'going') {
    if (!validCapacity(session.capacity)) return failure('This session has an invalid capacity.')
    const occupants = await tool<QueryActionData<RallyRSVP>>('records.query', {
      collection: 'rsvps',
      where: { sessionId: command.sessionId, status: 'going' },
      limit: session.capacity,
    }, command.userId)
    if (!occupants.success) return failure('Available places could not be checked.')
    if (occupants.data.records.length >= session.capacity) return failure('This session is full.')
  }
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

async function applyScoreEdit(command: ScoreEdit, session: RallySession, tool: RecordTool): Promise<RallyCommandResult> {
  if (session.hostId !== command.userId) return failure('Only the session host can edit the score.')
  if (session.status !== 'open') return failure('This session is closed.')

  const current = readMatchScore(session.matchScore)
  let next
  if (command.operation === 'startMatch') {
    if (session.matchScore) return failure('This session already has a scoreboard.')
    const teamSize = session.format === 'Singles' ? 1 : session.format === 'Doubles' ? 2 : 0
    const players = command.teams.flat()
    if (!teamSize || command.teams.some(team => team.length !== teamSize) || new Set(players).size !== players.length) {
      return failure('Choose distinct players for each side in the session format.')
    }
    for (const userId of players) {
      const result = await tool<QueryActionData<RallyRSVP>>('records.query', {
        collection: 'rsvps',
        where: { sessionId: command.sessionId, userId },
        limit: 1,
      }, command.userId)
      if (!result.success || result.data.records[0]?.data.status !== 'going') {
        return failure('Every player must have a confirmed RSVP for this session.')
      }
    }
    next = createMatchScore(command.teams)
  } else {
    if (!current || current.winner !== null) return failure('There is no active scoreboard.')
    if (current.revision !== command.revision) return failure('The score changed. Check the latest score before trying again.')
    next = awardPoint(current, command.side)
  }

  const result = await tool<MutateActionData>('records.update', {
    collection: 'sessions',
    recordId: command.sessionId,
    data: { matchScore: JSON.stringify(next) },
  }, command.userId)
  return result.success
    ? { success: true, data: { recordId: command.sessionId } }
    : failure('The score could not be saved.')
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
  const command = parseCommand({
    operation: params.operation,
    sessionId: params.sessionId,
    status: params.status,
    teams: params.teams,
    side: params.side,
    revision: params.revision,
    userId,
  })
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
