import type { ActionHandler, ActionResult, GetActionData, MutateActionData, QueryActionData } from 'deepspace/worker'
import type { RallyRSVP, RallySession, RallyWaitlist, RSVPStatus } from '../lib/rally.js'
import { resolveCapacity, sortWaitlistRows } from '../lib/rally.js'
import type { Env } from '../../worker.js'

type RallyCommand =
  | { operation: 'rsvp'; sessionId: string; status: RSVPStatus; userId: string }
  | { operation: 'cancel'; sessionId: string; userId: string }
  | { operation: 'withdraw'; sessionId: string; userId: string }
  | { operation: 'joinWaitlist'; sessionId: string; userId: string }
  | { operation: 'leaveWaitlist'; sessionId: string; userId: string }

type RallyCommandResult = ActionResult<{ recordId: string }>
type RecordTool = <T>(tool: string, params: Record<string, unknown>, userId: string) => Promise<ActionResult<T>>

/**
 * The `SESSION_FULL:` prefix is the structured FULL signal for the client:
 * the action result only carries an error string, so the UI detects a full
 * session with `error.startsWith('SESSION_FULL')` and offers the waitlist
 * instead of treating it as a generic failure. The human-readable part
 * after the prefix is shown as-is.
 */
const SESSION_FULL_PREFIX = 'SESSION_FULL: '

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseCommand(value: unknown): RallyCommand | null {
  if (!isRecord(value) || typeof value.userId !== 'string' || !value.userId ||
      typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 200) {
    return null
  }

  if (value.operation === 'cancel' || value.operation === 'withdraw' ||
      value.operation === 'joinWaitlist' || value.operation === 'leaveWaitlist') {
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

type QueryRow<T> = QueryActionData<T>['records'][number]

async function queryRows<T>(
  tool: RecordTool,
  collection: string,
  where: Record<string, unknown>,
  userId: string,
): Promise<QueryRow<T>[] | null> {
  const result = await tool<QueryActionData<T>>(
    'records.query',
    { collection, where, limit: 200 },
    userId,
  )
  return result.success ? result.data.records : null
}

async function findRsvp(tool: RecordTool, sessionId: string, userId: string): Promise<QueryRow<RallyRSVP> | null | undefined> {
  const rows = await queryRows<RallyRSVP>(tool, 'rsvps', { sessionId, userId }, userId)
  return rows === null ? undefined : (rows[0] ?? null)
}

async function countGoing(tool: RecordTool, sessionId: string, userId: string): Promise<number | null> {
  const rows = await queryRows<RallyRSVP>(tool, 'rsvps', { sessionId, status: 'going' }, userId)
  return rows === null ? null : rows.length
}

async function findWaitlistRow(tool: RecordTool, sessionId: string, userId: string): Promise<QueryRow<RallyWaitlist> | null | undefined> {
  const rows = await queryRows<RallyWaitlist>(tool, 'waitlists', { sessionId, userId }, userId)
  return rows === null ? undefined : (rows[0] ?? null)
}

async function deleteWaitlistRow(tool: RecordTool, recordId: string, actorUserId: string): Promise<boolean> {
  const result = await tool<MutateActionData>(
    'records.delete',
    { collection: 'waitlists', recordId },
    actorUserId,
  )
  return result.success
}

/**
 * Promote waitlisted players into freed spots, FIFO, inside the caller's
 * serialised queue turn. Runs after a 'going' RSVP is withdrawn or moved
 * to 'maybe'. Policy: automatic promotion, no offer window — the Durable
 * Object has no timers, and a promoted player who no longer wants the
 * spot simply withdraws, freeing it for the next in line.
 *
 * Ordering per iteration: create the promoted RSVP FIRST, then delete
 * the waitlist row. If the delete fails, the user temporarily holds both
 * rows; the next promotion pass sees they already hold a 'going' RSVP
 * and drops the stale waitlist row instead of promoting them twice.
 * Each iteration strictly increases the going count or removes a
 * waitlist row (or returns), so the loop always terminates.
 *
 * The promoted RSVP is created with the tool's userId set to the waiter:
 * userBound columns are stamped from that argument (SDK worker.js), so
 * this is the only way to create a row owned by someone else. This runs
 * inside the trusted command room — never from client code.
 */
async function promoteWaiters(tool: RecordTool, session: RallySession, sessionId: string, actorUserId: string): Promise<void> {
  const capacity = resolveCapacity(session)
  if (!capacity.limited || session.status !== 'open') return

  for (;;) {
    const going = await countGoing(tool, sessionId, actorUserId)
    if (going === null || going >= capacity.maxPlayers) return

    const rows = await queryRows<RallyWaitlist>(tool, 'waitlists', { sessionId }, actorUserId)
    if (rows === null || rows.length === 0) return
    const next = sortWaitlistRows(rows.map(r => ({ recordId: r.recordId, createdAt: r.createdAt, data: r.data })))[0]

    const existing = await findRsvp(tool, sessionId, next.data.userId)
    if (existing === undefined) return
    if (existing !== null && existing.data.status === 'going') {
      // Stale row: the user already holds a confirmed spot.
      if (!await deleteWaitlistRow(tool, next.recordId, actorUserId)) return
      continue
    }

    const created = await tool<MutateActionData>(
      'records.create',
      { collection: 'rsvps', data: { sessionId, status: 'going' } },
      next.data.userId,
    )
    if (!created.success) return
    // Delete failure is self-healing: the next pass drops this row as stale.
    if (!await deleteWaitlistRow(tool, next.recordId, actorUserId)) return
  }
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

  if (command.operation === 'withdraw') {
    // Withdrawing only removes the caller's own RSVP, so it is safe on a
    // cancelled session too — this matches the old direct-delete behaviour.
    // Serialising it here (instead of a direct removeConfirmed) keeps it
    // from racing an in-flight RSVP update inside the same queue turn,
    // and lets a freed spot promote the next waitlisted player atomically.
    const existing = await findRsvp(tool, command.sessionId, command.userId)
    if (existing === undefined) return failure('Your existing RSVP could not be checked.')
    if (existing === null) return { success: true, data: { recordId: command.sessionId } }

    const wasGoing = existing.data.status === 'going'
    const result = await tool<MutateActionData>(
      'records.delete',
      { collection: 'rsvps', recordId: existing.recordId },
      command.userId,
    )
    if (!result.success) return failure('Your RSVP could not be withdrawn.')
    if (wasGoing) await promoteWaiters(tool, session, command.sessionId, command.userId)
    return { success: true, data: { recordId: existing.recordId } }
  }

  if (command.operation === 'joinWaitlist') {
    if (session.status !== 'open') return failure('This session is not open for responses.')
    const capacity = resolveCapacity(session)
    if (!capacity.limited) return failure('This session has open participation and no waitlist.')
    const existingRsvp = await findRsvp(tool, command.sessionId, command.userId)
    if (existingRsvp === undefined) return failure('Your existing RSVP could not be checked.')
    if (existingRsvp !== null && existingRsvp.data.status === 'going') {
      return failure('You are already confirmed for this session.')
    }
    const going = await countGoing(tool, command.sessionId, command.userId)
    if (going === null) return failure('The waitlist could not be checked.')
    if (going < capacity.maxPlayers) {
      return failure('Spots are still available. RSVP going instead of joining the waitlist.')
    }
    const existingRow = await findWaitlistRow(tool, command.sessionId, command.userId)
    if (existingRow === undefined) return failure('The waitlist could not be checked.')
    if (existingRow !== null) return { success: true, data: { recordId: existingRow.recordId } }

    const result = await tool<MutateActionData>(
      'records.create',
      { collection: 'waitlists', data: { sessionId: command.sessionId } },
      command.userId,
    )
    return result.success
      ? { success: true, data: { recordId: result.data.recordId } }
      : failure('You could not be added to the waitlist.')
  }

  if (command.operation === 'leaveWaitlist') {
    // Leaving is safe on a cancelled session too: the row is inert there.
    const existingRow = await findWaitlistRow(tool, command.sessionId, command.userId)
    if (existingRow === undefined) return failure('The waitlist could not be checked.')
    if (existingRow === null) return { success: true, data: { recordId: command.sessionId } }

    const result = await tool<MutateActionData>(
      'records.delete',
      { collection: 'waitlists', recordId: existingRow.recordId },
      command.userId,
    )
    return result.success
      ? { success: true, data: { recordId: existingRow.recordId } }
      : failure('You could not leave the waitlist.')
  }

  if (session.status !== 'open') return failure('This session is not open for responses.')

  const existing = await findRsvp(tool, command.sessionId, command.userId)
  if (existing === undefined) return failure('Your existing RSVP could not be checked.')

  const alreadyGoing = existing !== null && existing.data.status === 'going'
  if (command.status === 'going' && !alreadyGoing) {
    const capacity = resolveCapacity(session)
    if (capacity.limited) {
      const going = await countGoing(tool, command.sessionId, command.userId)
      if (going === null) return failure('Your RSVP could not be saved.')
      if (going >= capacity.maxPlayers) {
        return failure(`${SESSION_FULL_PREFIX}This session is full. Join the waitlist and you will be promoted automatically if a spot opens.`)
      }
    }
  }

  const wasGoing = alreadyGoing
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

  if (!result.success) return failure('Your RSVP could not be saved.')

  if (command.status === 'going') {
    // A confirmed player should not also sit on the waitlist.
    const row = await findWaitlistRow(tool, command.sessionId, command.userId)
    if (row) await deleteWaitlistRow(tool, row.recordId, command.userId)
  } else if (wasGoing) {
    // going -> maybe frees a spot for the next waitlisted player.
    await promoteWaiters(tool, session, command.sessionId, command.userId)
  }

  return { success: true, data: { recordId: result.data.recordId } }
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
