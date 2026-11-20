import type { ActionHandler, ActionResult, GetActionData, MutateActionData, QueryActionData } from 'deepspace/worker'
import { validCapacity, type RallyRSVP, type RallySession, type RallyWaitlist, type RSVPStatus } from '../lib/rally.js'
import { awardPoint, createMatchScore, readMatchScore, resultStatus, reviewResult, scoreEditSchema } from '../lib/rally-score.js'
import { castVote, finalizePoll, parsePollOptions, parsePollTally, serializePollOptions, serializePollTally, tallyVotes, validatePollOptions, type PollOptionInput } from '../lib/polls.js'
import { occurrenceStartsAt, parseSeriesTemplate, serializeSeriesTemplate, validateSeries, type SeriesTemplate } from '../lib/recurrence.js'
import { pollCreatedKey, resultConfirmedKey, resultDisputedKey, scheduleChangedKey, sessionCancelledKey, waitlistPromotedKey } from '../lib/rally-notifications.js'
import { emitNotification, type EmitNotificationInput } from './notifications.js'
import type { z } from 'zod'
import { fetchGeocodedPlaces, GEOCODER_MIN_GAP_MS } from './court-discovery.js'
import type { Env } from '../../worker.js'

type ScoreEdit = z.infer<typeof scoreEditSchema> & { sessionId: string; userId: string }

type RallyCommand =
  | ScoreEdit
  | { operation: 'rsvp'; sessionId: string; status: RSVPStatus; userId: string }
  | { operation: 'withdraw' | 'joinWaitlist' | 'leaveWaitlist'; sessionId: string; userId: string }
  | { operation: 'cancel'; sessionId: string; userId: string }
  | { operation: 'createPoll'; sessionId: string; userId: string; options: PollOptionInput[] }
  | { operation: 'castVote' | 'withdrawVote'; sessionId: string; userId: string; pollId: string; optionId: string }
  | { operation: 'cancelPoll'; sessionId: string; userId: string; pollId: string }
  | { operation: 'finalizePoll'; sessionId: string; userId: string; pollId: string; optionId: string }

export interface RallyPoll {
  sessionId: string
  hostId: string
  options: string
  status: 'open' | 'finalized' | 'cancelled'
  finalizedOptionId: string
  tally: string
}

export interface RallyPollVote {
  pollId: string
  optionId: string
  userId: string
}

export interface RecurringSeriesRecord {
  hostId: string
  template: string
  startStartsAt: string
  intervalWeeks: number
  count: number
  status: 'active' | 'cancelled'
  generatedCount: number
}

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
  if (value.operation === 'createPoll' && Array.isArray(value.options)) {
    // Option shape is validated in applyPollCommand; parse only checks it is a list.
    return { operation: 'createPoll', sessionId: value.sessionId, userId: value.userId, options: value.options as PollOptionInput[] }
  }
  if ((value.operation === 'castVote' || value.operation === 'withdrawVote') &&
      typeof value.pollId === 'string' && value.pollId &&
      typeof value.optionId === 'string' && value.optionId) {
    return { operation: value.operation, sessionId: value.sessionId, userId: value.userId, pollId: value.pollId, optionId: value.optionId }
  }
  if (value.operation === 'cancelPoll' && typeof value.pollId === 'string' && value.pollId) {
    return { operation: 'cancelPoll', sessionId: value.sessionId, userId: value.userId, pollId: value.pollId }
  }
  if (value.operation === 'finalizePoll' &&
      typeof value.pollId === 'string' && value.pollId &&
      typeof value.optionId === 'string' && value.optionId) {
    return { operation: 'finalizePoll', sessionId: value.sessionId, userId: value.userId, pollId: value.pollId, optionId: value.optionId }
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
    if (!result.success) return failure('The session could not be cancelled.')
    // Best-effort: a notification failure never un-cancels the session.
    await notifySessionCancelled(tool, session, command.sessionId, command.userId)
    return { success: true, data: { recordId: command.sessionId } }
  }

  if (command.operation === 'startMatch' || command.operation === 'scorePoint' || command.operation === 'reviewResult') {
    return applyScoreEdit(command, session, tool)
  }

  if (command.operation === 'createPoll' || command.operation === 'castVote' ||
      command.operation === 'withdrawVote' || command.operation === 'cancelPoll' ||
      command.operation === 'finalizePoll') {
    return applyPollCommand(command, session, tool)
  }

  if (command.operation === 'rsvp' || command.operation === 'withdraw' ||
      command.operation === 'joinWaitlist' || command.operation === 'leaveWaitlist') {
    return applyAttendance(command, session, tool)
  }

  return failure('Invalid rally command.')
}

/** Notify every RSVP holder (going/maybe) except `excludeUserId`. Best-effort: never throws. */
async function notifyRsvpHolders(
  tool: RecordTool,
  sessionId: string,
  excludeUserId: string,
  makeInput: (recipientId: string) => Omit<EmitNotificationInput, 'recipientId'>,
): Promise<void> {
  const found = await tool<QueryActionData<RallyRSVP>>(
    'records.query',
    { collection: 'rsvps', where: { sessionId }, limit: 100 },
    excludeUserId,
  )
  if (!found.success) return
  for (const record of found.data.records) {
    const recipientId = record.data.userId
    if (recipientId === excludeUserId) continue
    await emitNotification(tool, { recipientId, ...makeInput(recipientId) })
  }
}

async function notifySessionCancelled(
  tool: RecordTool,
  session: RallySession,
  sessionId: string,
  hostId: string,
): Promise<void> {
  await notifyRsvpHolders(tool, sessionId, hostId, recipientId => ({
    type: 'session_cancelled',
    sessionId,
    title: `Cancelled: ${session.title}`,
    body: `${session.title} was cancelled by its organizer.`,
    link: `/rallies?session=${sessionId}`,
    idempotencyKey: sessionCancelledKey(sessionId, recipientId),
  }))
}

type AttendanceCommand = Extract<RallyCommand, { operation: 'rsvp' | 'withdraw' | 'joinWaitlist' | 'leaveWaitlist' }>

async function applyAttendance(command: AttendanceCommand, session: RallySession, tool: RecordTool): Promise<RallyCommandResult> {
  const { sessionId, userId, operation } = command
  if (session.status !== 'open' && operation !== 'leaveWaitlist' && operation !== 'withdraw') {
    return failure('This session is not open for responses.')
  }
  const owns = { sessionId, userId }
  const configuredCapacity = session.capacity
  const capacity = configuredCapacity != null && validCapacity(configuredCapacity) ? configuredCapacity : null
  if (configuredCapacity != null && capacity === null && operation !== 'leaveWaitlist' && operation !== 'withdraw') {
    return failure('This session has an invalid capacity.')
  }

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
  // A single retry of the queue delete happens inside this same command
  // (Track A D1), so one transient storage failure does not block the
  // caller's own command. If the retry also fails, the command returns
  // null and the next attendance command repairs the row.
  // Returns the confirmed count plus the RSVP record ids that were newly
  // confirmed in this call, so callers can notify promoted players. The
  // promotion notice is emitted here, right after the queue-row delete
  // succeeds, because at that point the promotion is durable; the
  // idempotency key (the RSVP record id) makes a repair re-run a no-op.
  async function fillVacancies(): Promise<{ count: number; promoted: string[] } | null> {
    if (capacity == null || session.status !== 'open') return { count: 0, promoted: [] }
    const promoted: string[] = []
    for (let attempt = 0; attempt < 32; attempt++) {
      const confirmed = await query<RallyRSVP>('rsvps', { sessionId, status: 'going' }, capacity)
      if (!confirmed.success) return null
      const count = confirmed.data.records.length
      const queued = await query<RallyWaitlist>('waitlists', { sessionId }, 1, true)
      if (!queued.success) return null
      const first = queued.data.records[0]
      if (!first) return { count, promoted }
      const player = first.data.userId
      const response = await query<RallyRSVP>('rsvps', { sessionId, userId: player })
      if (!response.success) return null
      const rsvp = response.data.records[0]
      let promotedRecordId: string | null = null
      if (rsvp?.data.status !== 'going') {
        if (count >= capacity) return { count, promoted }
        const saved = await save(player, 'going', rsvp?.recordId)
        if (!saved.success) return null
        promotedRecordId = saved.data.recordId
      } else {
        // Interrupted-cleanup repair: the player already holds a going
        // RSVP and only the stale queue row remains.
        promotedRecordId = rsvp.recordId
      }
      const deleted = (await remove('waitlists', first.recordId)).success ||
        (await remove('waitlists', first.recordId)).success
      if (!deleted) return null
      if (promotedRecordId) {
        promoted.push(promotedRecordId)
        await emitNotification(tool, {
          recipientId: player,
          type: 'waitlist_promoted',
          sessionId,
          title: `You're in: ${session.title}`,
          body: `A place opened up for ${session.title}. You're confirmed.`,
          link: `/rallies?session=${sessionId}`,
          idempotencyKey: waitlistPromotedKey(promotedRecordId),
        })
      }
    }
    return null
  }

  if (operation === 'leaveWaitlist' || operation === 'withdraw') {
    if (configuredCapacity != null) {
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
  const vacancy = capacity != null ? await fillVacancies() : { count: 0, promoted: [] }
  const filled = vacancy === null ? null : vacancy.count
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

type PollCommand = Extract<RallyCommand, { operation: 'createPoll' | 'castVote' | 'withdrawVote' | 'cancelPoll' | 'finalizePoll' }>

async function loadPoll(tool: RecordTool, pollId: string, userId: string) {
  const result = await tool<GetActionData<RallyPoll>>(
    'records.get',
    { collection: 'polls', recordId: pollId },
    userId,
  )
  return result.success ? result.data.record : null
}

async function isSessionParticipant(
  tool: RecordTool,
  sessionId: string,
  userId: string,
  hostId: string,
): Promise<boolean | null> {
  if (userId === hostId) return true
  const result = await tool<QueryActionData<RallyRSVP>>(
    'records.query',
    { collection: 'rsvps', where: { sessionId, userId }, limit: 1 },
    userId,
  )
  if (!result.success) return null
  return result.data.records.length > 0
}

async function refreshPollTally(tool: RecordTool, pollId: string, userId: string): Promise<void> {
  const votes = await tool<QueryActionData<RallyPollVote>>(
    'records.query',
    { collection: 'pollVotes', where: { pollId }, limit: 500 },
    userId,
  )
  if (!votes.success) return
  const tally = tallyVotes(votes.data.records.map(record => ({
    optionId: record.data.optionId,
    userId: record.data.userId,
  })))
  await tool<MutateActionData>(
    'records.update',
    { collection: 'polls', recordId: pollId, data: { tally: serializePollTally(tally) } },
    userId,
  )
}

async function applyPollCommand(
  command: PollCommand,
  session: RallySession,
  tool: RecordTool,
): Promise<RallyCommandResult> {
  const { sessionId, userId, operation } = command
  if (session.status !== 'open' && operation !== 'withdrawVote' && operation !== 'cancelPoll') {
    return failure('This session is not open for responses.')
  }

  if (operation === 'createPoll') {
    if (session.hostId !== userId) return failure('Only the session host can create a poll.')
    const options = command.options
    if (!Array.isArray(options) || options.some(option =>
      typeof option !== 'object' || option === null ||
      typeof (option as { id: unknown }).id !== 'string' ||
      typeof (option as { startsAt: unknown }).startsAt !== 'string')) {
      return failure('Each proposed time needs a unique id.')
    }
    const problem = validatePollOptions(options)
    if (problem) return failure(problem)
    const existing = await tool<QueryActionData<RallyPoll>>(
      'records.query',
      { collection: 'polls', where: { sessionId }, limit: 1 },
      userId,
    )
    if (!existing.success) return failure('Existing polls could not be checked.')
    if (existing.data.records.length > 0) return failure('This session already has a poll.')
    const created = await tool<MutateActionData>(
      'records.create',
      {
        collection: 'polls',
        data: { sessionId, options: serializePollOptions(options), status: 'open', finalizedOptionId: '', tally: '{}' },
      },
      userId,
    )
    if (!created.success) return failure('The poll could not be created.')
    const pollId = created.data.recordId
    await notifyRsvpHolders(tool, sessionId, userId, recipientId => ({
      type: 'poll_created',
      sessionId,
      title: `New time poll: ${session.title}`,
      body: `The host proposed new times for ${session.title}. Cast your vote.`,
      link: `/rallies?session=${sessionId}`,
      idempotencyKey: pollCreatedKey(pollId, recipientId),
    }))
    return { success: true, data: { recordId: pollId } }
  }

  const poll = await loadPoll(tool, command.pollId, userId)
  if (!poll || poll.data.sessionId !== sessionId) return failure('This poll is unavailable.')
  const pollData = poll.data
  const options = parsePollOptions(pollData.options)
  if (!options) return failure('This poll is unavailable.')
  const optionIds = options.map(option => option.id)

  if (operation === 'castVote') {
    if (pollData.status !== 'open') return failure('This poll is not open for voting.')
    const participant = await isSessionParticipant(tool, sessionId, userId, session.hostId)
    if (participant === null) return failure('Your participation could not be checked.')
    if (!participant) return failure('Only session participants can vote.')
    if (!optionIds.includes(command.optionId)) return failure('That time is not part of this poll.')
    const existing = await tool<QueryActionData<RallyPollVote>>(
      'records.query',
      { collection: 'pollVotes', where: { pollId: command.pollId, optionId: command.optionId, userId }, limit: 1 },
      userId,
    )
    if (!existing.success) return failure('Your vote could not be checked.')
    if (existing.data.records[0]) return { success: true, data: { recordId: existing.data.records[0].recordId } }
    const created = await tool<MutateActionData>(
      'records.create',
      { collection: 'pollVotes', data: { pollId: command.pollId, optionId: command.optionId } },
      userId,
    )
    if (!created.success) return failure('Your vote could not be saved.')
    await refreshPollTally(tool, command.pollId, userId)
    return { success: true, data: { recordId: created.data.recordId } }
  }

  if (operation === 'withdrawVote') {
    if (pollData.status === 'finalized') return failure('This poll is closed.')
    const existing = await tool<QueryActionData<RallyPollVote>>(
      'records.query',
      { collection: 'pollVotes', where: { pollId: command.pollId, optionId: command.optionId, userId }, limit: 1 },
      userId,
    )
    if (!existing.success) return failure('Your vote could not be checked.')
    const vote = existing.data.records[0]
    if (vote) {
      const removed = await tool<MutateActionData>(
        'records.delete',
        { collection: 'pollVotes', recordId: vote.recordId },
        userId,
      )
      if (!removed.success) return failure('Your vote could not be withdrawn.')
      await refreshPollTally(tool, command.pollId, userId)
    }
    return { success: true, data: { recordId: command.pollId } }
  }

  if (operation === 'cancelPoll') {
    if (session.hostId !== userId) return failure('Only the session host can cancel the poll.')
    if (pollData.status !== 'open') return failure('This poll is already closed.')
    const updated = await tool<MutateActionData>(
      'records.update',
      { collection: 'polls', recordId: command.pollId, data: { status: 'cancelled' } },
      userId,
    )
    return updated.success
      ? { success: true, data: { recordId: command.pollId } }
      : failure('The poll could not be cancelled.')
  }

  // finalizePoll
  if (session.hostId !== userId) return failure('Only the session host can finalise a poll.')
  if (pollData.status !== 'open') return failure('This poll is not open.')
  const chosen = options.find(option => option.id === command.optionId)
  if (!chosen) return failure('That time is not part of this poll.')
  if (Date.parse(chosen.startsAt) <= Date.now()) return failure('The proposed time is no longer in the future.')
  const guard = finalizePoll(session.hostId, userId, command.optionId, optionIds)
  if ('error' in guard) return failure(guard.error)
  const updatedSession = await tool<MutateActionData>(
    'records.update',
    {
      collection: 'sessions',
      recordId: sessionId,
      data: { startsAt: chosen.startsAt, scheduleRevision: (session.scheduleRevision ?? 0) + 1 },
    },
    userId,
  )
  if (!updatedSession.success) return failure('The session time could not be updated.')
  const updatedPoll = await tool<MutateActionData>(
    'records.update',
    { collection: 'polls', recordId: command.pollId, data: { status: 'finalized', finalizedOptionId: command.optionId } },
    userId,
  )
  if (!updatedPoll.success) return failure('The poll could not be finalised.')
  // RSVPs carry over untouched (G08): participants are notified, not silently moved.
  await notifyRsvpHolders(tool, sessionId, userId, recipientId => ({
    type: 'schedule_changed',
    sessionId,
    title: `New time: ${session.title}`,
    body: `${session.title} moved to ${chosen.startsAt}. Your RSVP carries over.`,
    link: `/rallies?session=${sessionId}`,
    idempotencyKey: scheduleChangedKey(sessionId, chosen.startsAt, recipientId),
  }))
  return { success: true, data: { recordId: sessionId } }
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
  if (command.operation === 'reviewResult') {
    const players = [...new Set(next.teams.flat())]
    const type = next.disputed
      ? 'result_disputed' as const
      : resultStatus(next) === 'final'
        ? 'result_confirmed' as const
        : null
    if (type) {
      for (const recipientId of players) {
        await emitNotification(tool, {
          recipientId,
          type,
          sessionId: command.sessionId,
          title: next.disputed ? `Result disputed: ${session.title}` : `Result confirmed: ${session.title}`,
          body: next.disputed
            ? `A player disputed the result of ${session.title}. It is on hold until resolved.`
            : `Every participant approved the result of ${session.title}. It is now final.`,
          link: `/rallies?session=${command.sessionId}`,
          idempotencyKey: next.disputed
            ? resultDisputedKey(command.sessionId, next.revision, recipientId)
            : resultConfirmedKey(command.sessionId, next.revision, recipientId),
        })
      }
    }
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
    const seriesCommand = command ? null : parseSeriesCommand(body)

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

    if (command) return Response.json(await applyCommand(command, tool))
    if (seriesCommand) return Response.json(await applySeriesCommand(seriesCommand, tool))
    return Response.json(failure('Invalid rally command.'), { status: 400 })
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
    options: params.options,
    pollId: params.pollId,
    optionId: params.optionId,
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

type SeriesCommand =
  | { operation: 'createSeries'; userId: string; seriesId: string; template: SeriesTemplate; startStartsAt: string; intervalWeeks: number; count: number }
  | { operation: 'generateOccurrences'; userId: string; seriesId: string }
  | { operation: 'cancelSeries'; userId: string; seriesId: string }

function parseSeriesCommand(value: unknown): SeriesCommand | null {
  if (!isRecord(value) || typeof value.userId !== 'string' || !value.userId) return null
  if (value.operation === 'createSeries' &&
      typeof value.seriesId === 'string' && value.seriesId &&
      typeof value.startStartsAt === 'string' &&
      typeof value.intervalWeeks === 'number' && typeof value.count === 'number' &&
      isRecord(value.template)) {
    return {
      operation: 'createSeries',
      userId: value.userId,
      seriesId: value.seriesId,
      template: value.template as unknown as SeriesTemplate,
      startStartsAt: value.startStartsAt,
      intervalWeeks: value.intervalWeeks,
      count: value.count,
    }
  }
  if ((value.operation === 'generateOccurrences' || value.operation === 'cancelSeries') &&
      typeof value.seriesId === 'string' && value.seriesId) {
    return { operation: value.operation, userId: value.userId, seriesId: value.seriesId }
  }
  return null
}

async function applySeriesCommand(command: SeriesCommand, tool: RecordTool): Promise<RallyCommandResult> {
  if (command.operation === 'createSeries') {
    const problem = validateSeries({
      template: command.template,
      startStartsAt: command.startStartsAt,
      intervalWeeks: command.intervalWeeks,
      count: command.count,
    })
    if (problem) return failure(problem)
    const created = await tool<MutateActionData>(
      'records.create',
      {
        collection: 'recurringSeries',
        data: {
          template: serializeSeriesTemplate(command.template),
          startStartsAt: new Date(Date.parse(command.startStartsAt)).toISOString(),
          intervalWeeks: command.intervalWeeks,
          count: command.count,
          status: 'active',
          generatedCount: 0,
        },
        recordId: command.seriesId,
      },
      command.userId,
    )
    return created.success
      ? { success: true, data: { recordId: command.seriesId } }
      : failure('The series could not be created.')
  }

  const found = await tool<GetActionData<RecurringSeriesRecord>>(
    'records.get',
    { collection: 'recurringSeries', recordId: command.seriesId },
    command.userId,
  )
  if (!found.success) return failure('This series is unavailable.')
  const series = found.data.record.data
  if (series.hostId !== command.userId) return failure('Only the series host can change it.')

  if (command.operation === 'generateOccurrences') {
    if (series.status !== 'active') return failure('This series is not active.')
    if (series.generatedCount >= series.count) return failure('All occurrences have already been generated.')
    const template = parseSeriesTemplate(series.template)
    if (!template) return failure('This series is unavailable.')
    for (let index = series.generatedCount; index < series.count; index++) {
      const startsAt = occurrenceStartsAt(series.startStartsAt, index, series.intervalWeeks)
      if (Date.parse(startsAt) <= Date.now()) return failure('A series occurrence is no longer in the future.')
      const created = await tool<MutateActionData>(
        'records.create',
        {
          collection: 'sessions',
          data: { ...template, startsAt, seriesId: command.seriesId, chatChannelId: '', status: 'open' },
        },
        command.userId,
      )
      if (!created.success) return failure('A series session could not be created.')
      const rsvp = await tool<MutateActionData>(
        'records.create',
        { collection: 'rsvps', data: { sessionId: created.data.recordId, status: 'going' } },
        command.userId,
      )
      if (!rsvp.success) return failure('The host RSVP could not be saved.')
    }
    const updated = await tool<MutateActionData>(
      'records.update',
      { collection: 'recurringSeries', recordId: command.seriesId, data: { generatedCount: series.count } },
      command.userId,
    )
    return updated.success
      ? { success: true, data: { recordId: command.seriesId } }
      : failure('The series could not be updated.')
  }

  // cancelSeries
  if (series.status !== 'active') return failure('This series is already cancelled.')
  const instances = await tool<QueryActionData<RallySession>>(
    'records.query',
    { collection: 'sessions', where: { seriesId: command.seriesId, status: 'open' }, limit: 50 },
    command.userId,
  )
  if (!instances.success) return failure('Series sessions could not be checked.')
  const now = Date.now()
  for (const instance of instances.data.records) {
    if (Date.parse(instance.data.startsAt) <= now) continue
    const cancelled = await tool<MutateActionData>(
      'records.update',
      { collection: 'sessions', recordId: instance.recordId, data: { status: 'cancelled' } },
      command.userId,
    )
    if (cancelled.success) {
      await notifySessionCancelled(tool, instance.data, instance.recordId, command.userId)
    }
  }
  const updated = await tool<MutateActionData>(
    'records.update',
    { collection: 'recurringSeries', recordId: command.seriesId, data: { status: 'cancelled' } },
    command.userId,
  )
  return updated.success
    ? { success: true, data: { recordId: command.seriesId } }
    : failure('The series could not be cancelled.')
}

export const schedulingAction: ActionHandler<Env> = async ({ userId, params, env }) => {
  const command = parseSeriesCommand({
    operation: params.operation,
    seriesId: params.seriesId ?? (params.operation === 'createSeries' ? crypto.randomUUID() : undefined),
    template: params.template,
    startStartsAt: params.startStartsAt,
    intervalWeeks: params.intervalWeeks,
    count: params.count,
    userId,
  })
  if (!command) return failure('Invalid scheduling command.')
  const roomName = command.operation === 'createSeries'
    ? `rally:${env.DEEPSPACE_APP_ID}:series-create:${userId}`
    : `rally:${env.DEEPSPACE_APP_ID}:series:${command.seriesId}`
  const room = env.RALLY_COMMAND_ROOMS.get(env.RALLY_COMMAND_ROOMS.idFromName(roomName))
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
