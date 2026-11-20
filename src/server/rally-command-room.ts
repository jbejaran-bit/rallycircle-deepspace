import type { ActionHandler, ActionResult, GetActionData, MutateActionData, QueryActionData } from 'deepspace/worker'
import { validCapacity, type RallyRSVP, type RallySession, type RallyWaitlist, type RSVPStatus } from '../lib/rally.js'
import { awardPoint, createMatchScore, readMatchScore, resultStatus, reviewResult, scoreEditSchema, type MatchScore } from '../lib/rally-score.js'
import { applyFinalizedResultToStore, finalizedResultsFromSessions } from './rating-records.js'
import type { z } from 'zod'
import { fetchGeocodedPlaces, GEOCODER_MIN_GAP_MS } from './court-discovery.js'
import type { Env } from '../../worker.js'

type ScoreEdit = z.infer<typeof scoreEditSchema> & { sessionId: string; userId: string }

type RallyCommand =
  | ScoreEdit
  | { operation: 'rsvp'; sessionId: string; status: RSVPStatus; userId: string }
  | { operation: 'withdraw' | 'joinWaitlist' | 'leaveWaitlist'; sessionId: string; userId: string }
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

  if (value.operation === 'cancel' || value.operation === 'withdraw' ||
      value.operation === 'joinWaitlist' || value.operation === 'leaveWaitlist') {
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

  if (command.operation === 'startMatch' || command.operation === 'scorePoint' || command.operation === 'reviewResult') {
    return applyScoreEdit(command, session, tool)
  }

  return applyAttendance(command, session, tool)
}

type AttendanceCommand = Extract<RallyCommand, { operation: 'rsvp' | 'withdraw' | 'joinWaitlist' | 'leaveWaitlist' }>

async function applyAttendance(command: AttendanceCommand, session: RallySession, tool: RecordTool): Promise<RallyCommandResult> {
  const { sessionId, userId, operation } = command
  if (session.status !== 'open' && operation !== 'leaveWaitlist' && operation !== 'withdraw') {
    return failure('This session is not open for responses.')
  }
  const owns = { sessionId, userId }
  const capacity = session.capacity
  if (capacity != null && !validCapacity(capacity)) return failure('This session has an invalid capacity.')

  const query = <T>(collection: string, where: Record<string, unknown>, limit = 1, oldest = false) =>
    tool<QueryActionData<T>>('records.query', {
      collection, where, limit, ...(oldest ? { orderBy: 'createdAt', orderDir: 'asc' } : {}),
    }, userId)
  const remove = (collection: string, recordId: string) =>
    tool<MutateActionData>('records.delete', { collection, recordId }, userId)
  const save = (player: string, status: RSVPStatus, recordId?: string) =>
    recordId
      ? tool<MutateActionData>('records.update', { collection: 'rsvps', recordId, data: { status } }, player)
      : tool<MutateActionData>('records.create', { collection: 'rsvps', data: { sessionId, status } }, player)
  const success = (recordId = sessionId): RallyCommandResult => ({ success: true, data: { recordId } })

  // Persist the RSVP before deleting the queue entry. The next command can
  // repair that intermediate state without consuming a second place.
  async function fillVacancies(): Promise<number | null> {
    if (capacity == null || session.status !== 'open') return 0
    for (let attempt = 0; attempt < 32; attempt++) {
      const confirmed = await query<RallyRSVP>('rsvps', { sessionId, status: 'going' }, capacity)
      if (!confirmed.success) return null
      const count = confirmed.data.records.length
      const queued = await query<RallyWaitlist>('waitlists', { sessionId }, 1, true)
      if (!queued.success) return null
      const first = queued.data.records[0]
      if (!first) return count
      const player = first.data.userId
      const response = await query<RallyRSVP>('rsvps', { sessionId, userId: player })
      if (!response.success) return null
      const rsvp = response.data.records[0]
      if (rsvp?.data.status !== 'going') {
        if (count >= capacity) return count
        if (!(await save(player, 'going', rsvp?.recordId)).success) return null
      }
      if (!(await remove('waitlists', first.recordId)).success) return null
    }
    return null
  }

  if (operation === 'leaveWaitlist' || operation === 'withdraw') {
    if (capacity != null) {
      const response = await query<RallyWaitlist>('waitlists', owns)
      if (!response.success) return failure('Your waitlist entry could not be checked.')
      const waiting = response.data.records[0]
      if (waiting && !(await remove('waitlists', waiting.recordId)).success) return failure('You could not leave the waitlist.')
    }
    if (operation === 'withdraw') {
      const response = await query<RallyRSVP>('rsvps', owns)
      if (!response.success) return failure('Your existing RSVP could not be checked.')
      const existing = response.data.records[0]
      if (existing && !(await remove('rsvps', existing.recordId)).success) return failure('Your RSVP could not be withdrawn.')
    }
    await fillVacancies()
    return success()
  }

  if (capacity == null && operation === 'joinWaitlist') return failure('This session has no waitlist.')
  const filled = capacity != null ? await fillVacancies() : 0
  const response = await query<RallyRSVP>('rsvps', owns)
  if (!response.success) return failure('Your existing RSVP could not be checked.')
  const existing = response.data.records[0]
  if (operation === 'joinWaitlist') {
    if (existing?.data.status === 'going') return failure('You are already confirmed for this session.')
    if (filled === null) return failure('The waitlist is temporarily unavailable. Try again.')
    if (capacity != null && filled < capacity) return failure('A spot is available. Choose Going to join.')
    const queued = await query<RallyWaitlist>('waitlists', owns)
    if (!queued.success) return failure('Your waitlist entry could not be checked.')
    const waiting = queued.data.records[0]
    if (waiting) return success(waiting.recordId)
    const created = await tool<MutateActionData>('records.create', {
      collection: 'waitlists', data: { sessionId },
    }, userId)
    return created.success ? success(created.data.recordId) : failure('You could not join the waitlist.')
  }

  if (operation !== 'rsvp') return failure('Invalid attendance command.')
  if (capacity != null && command.status === 'going' && existing?.data.status !== 'going') {
    if (filled === null) return failure('Available places could not be checked. Try again.')
    if (filled >= capacity) return failure('This session is full. You can join the waitlist.')
  }
  const wasGoing = existing?.data.status === 'going'
  const result = await save(userId, command.status, existing?.recordId)
  if (!result.success) return failure('Your RSVP could not be saved.')
  if (command.status === 'maybe' && wasGoing) {
    await fillVacancies()
  }
  return success(result.data.recordId)
}

/**
 * Best-effort rating update for a newly finalized result. Ratings are
 * derived state; the finalized result is the source of truth, so a rating
 * failure must never fail the review itself. Runs inside the same
 * serialized command-room invocation, so two concurrent finalizing reviews
 * cannot double-apply (the idempotency check in the applier is the
 * backstop). A failed apply is retried by re-applying the same resultId.
 * Ratings are experimental (docs/RATING_SPEC.md) and never authoritative.
 */
async function applyRatingsForFinalResult(
  command: ScoreEdit,
  session: RallySession,
  next: MatchScore,
  tool: RecordTool,
): Promise<void> {
  try {
    const [finalized] = finalizedResultsFromSessions([
      { recordId: command.sessionId, data: { ...session, matchScore: JSON.stringify(next) } },
    ])
    if (!finalized) return
    const outcome = await applyFinalizedResultToStore(finalized, tool, command.userId)
    if (outcome.error) console.error('Rating update failed', finalized.resultId, outcome.error)
  } catch (error) {
    console.error('Rating update failed', command.sessionId, error)
  }
}

async function applyScoreEdit(command: ScoreEdit, session: RallySession, tool: RecordTool): Promise<RallyCommandResult> {
  if (command.operation !== 'reviewResult' && session.hostId !== command.userId) return failure('Only the session host can edit the score.')
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
  } else if (command.operation === 'reviewResult') {
    next = current && reviewResult(current, command.userId, command.decision)
    if (!next) return failure('This result is closed or unavailable for your review.')
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
  if (!result.success) return failure('The score could not be saved.')
  if (command.operation === 'reviewResult' && next && resultStatus(next) === 'final') {
    await applyRatingsForFinalResult(command, session, next, tool)
  }
  return { success: true, data: { recordId: command.sessionId } }
}

export class RallyCommandRoom {
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  fetch(request: Request): Promise<Response> {
    if (request.method === 'POST' && new URL(request.url).pathname === '/geocode') {
      return this.geocode(request)
    }
    const result = this.queue.then(() => this.handle(request))
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private async geocode(request: Request): Promise<Response> {
    const query = (await request.text()).trim()
    if (query.length < 2 || query.length > 200) return Response.json({ error: 'Invalid place name.' }, { status: 400 })

    // Every Worker isolate uses this same object ID, so the provider limit
    // survives both concurrent calls and object eviction.
    const allowed = await this.state.storage.transaction(async storage => {
      const now = Date.now()
      const last = await storage.get<number>('geocodeLastStart')
      if (last !== undefined && now - last < GEOCODER_MIN_GAP_MS) return false
      await storage.put('geocodeLastStart', now)
      return true
    })
    if (!allowed) return Response.json({ error: 'Place search is busy. Try again in a moment.' }, {
      status: 429,
      headers: { 'Retry-After': '2' },
    })

    try {
      return Response.json(await fetchGeocodedPlaces(query))
    } catch (cause) {
      if (cause instanceof Response) return cause
      return Response.json({ error: 'Place search is unavailable.' }, { status: 502 })
    }
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
    decision: params.decision,
    userId,
  })
  if (!command) return failure('Invalid rally command.')

  const sessionResult = await tools.get('sessions', command.sessionId)
  if (!sessionResult.success) return failure('This session is unavailable.')

  const room = env.RALLY_COMMAND_ROOMS.get(
    env.RALLY_COMMAND_ROOMS.idFromName(`rally:${env.DEEPSPACE_APP_ID}:${command.sessionId}`),
  )
  let result: unknown
  try {
    const response = await room.fetch(
      new Request('https://internal/rally-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
      }),
    )
    if (!response.ok) return failure('The session service is temporarily unavailable. Try again.')
    result = await response.json()
  } catch {
    return failure('The session service is temporarily unavailable. Try again.')
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
