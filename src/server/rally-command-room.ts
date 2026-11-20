import type { ActionHandler, ActionResult, GetActionData, MutateActionData, QueryActionData } from 'deepspace/worker'
import type { RallyRSVP, RallySession, RSVPStatus } from '../lib/rally.js'
import type { Env } from '../../worker.js'

type RallyCommand =
  | { operation: 'rsvp'; sessionId: string; status: RSVPStatus; userId: string }
  | { operation: 'cancel'; sessionId: string; userId: string }
  | { operation: 'withdraw'; sessionId: string; userId: string }

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

  if (value.operation === 'cancel' || value.operation === 'withdraw') {
    return { operation: value.operation, sessionId: value.sessionId, userId: value.userId }
  }
  if (value.operation === 'rsvp' && (value.status === 'going' || value.status === 'maybe')) {
    return { operation: value.operation, sessionId: value.sessionId, status: value.status, userId: value.userId }
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
  if (command.operation === 'withdraw') {
    // Withdrawing is harmless cleanup, so it is allowed on a cancelled
    // session too. It is scoped to the caller's own RSVP row only: the
    // query filters on sessionId + userId and only that recordId is
    // deleted — never a deleteWhere. Withdrawing twice is a success, not
    // an error, so a retried or double-clicked withdraw cannot surface a
    // spurious "Record not found".
    const existingResult = await tool<QueryActionData<RallyRSVP>>(
      'records.query',
      {
        collection: 'rsvps',
        where: { sessionId: command.sessionId, userId: command.userId },
        limit: 1,
      },
      command.userId,
    )
    if (!existingResult.success) return failure('Your RSVP could not be checked.')

    const existing = existingResult.data.records[0]
    if (!existing) return { success: true, data: { recordId: command.sessionId } }

    const result = await tool<MutateActionData>(
      'records.delete',
      { collection: 'rsvps', recordId: existing.recordId },
      command.userId,
    )
    return result.success
      ? { success: true, data: { recordId: existing.recordId } }
      : failure('Your RSVP could not be withdrawn.')
  }

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

// SECURITY: this room trusts the userId in the request body. It must only
// ever be called by rallyCommandAction, which rebuilds the command from the
// verified Bearer identity and ignores any userId in the request params.
// Do not expose this Durable Object on a public route: a direct caller
// could cancel or withdraw as any user. (Review finding N-03.)
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
    userId,
  })
  if (!command) return failure('Invalid rally command.')

  const sessionResult = await tools.get('sessions', command.sessionId)
  if (!sessionResult.success) return failure('This session is unavailable.')

  const room = env.RALLY_COMMAND_ROOMS.get(
    env.RALLY_COMMAND_ROOMS.idFromName(`rally:${env.DEEPSPACE_APP_ID}:${command.sessionId}`),
  )
  let response: Response
  try {
    response = await room.fetch(
      new Request('https://internal/rally-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
      }),
    )
  } catch {
    return failure('The session update could not reach the server. Try again.')
  }
  let result: unknown
  try {
    result = await response.json()
  } catch {
    return failure('The session update returned an unreadable response. Try again.')
  }
  if (
    isRecord(result) &&
    ((result.success === true && isRecord(result.data) && typeof result.data.recordId === 'string') ||
      (result.success === false && typeof result.error === 'string'))
  ) {
    return result as RallyCommandResult
  }
  return failure('The rally command returned an invalid response.')
}
