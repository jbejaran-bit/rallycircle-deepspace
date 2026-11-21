import { recordPages } from './record-pages.js'
import type { ActionHandler, ActionResult, GetActionData, MutateActionData, QueryActionData } from 'deepspace/worker'
import { BodyTooLargeError, readBoundedBodyText } from 'deepspace/worker'
import { validCapacity, type RallyRSVP, type RallySession, type RallyWaitlist, type RSVPStatus } from '../lib/rally.js'
import { awardPoint, correctResult, createMatchScore, isFinalTransition, readMatchScore, resultStatus, reviewResult, scoreEditSchema, validateCorrectedSets } from '../lib/rally-score.js'
import { castVote, parsePollOptions, parsePollTally, serializePollOptions, serializePollTally, tallyVotes, validatePollOptions, type PollOptionInput } from '../lib/polls.js'
import { occurrenceStartsAt, parseSeriesTemplate, serializeSeriesTemplate, validateSeries, type SeriesTemplate } from '../lib/recurrence.js'
import { pollCreatedKey, resultConfirmedKey, resultDisputedKey, scheduleChangedKey, sessionCancelledKey, waitlistPromotedKey } from '../lib/rally-notifications.js'
import { emitNotification, type EmitNotificationInput } from './notifications.js'
import type { z } from 'zod'
import { applyFinalization, writeAudit } from './result-finalization.js'
import { fetchGeocodedPlaces, GEOCODER_MIN_GAP_MS } from './court-discovery.js'
import type { Env } from '../../worker.js'

/** Largest command body the room will read (K05). Commands are small JSON; anything larger is rejected, never parsed. */
const MAX_COMMAND_BODY_BYTES = 64 * 1024

/** Per-user, per-session, per-class rate limits (K03), fixed 60 s windows, kept in memory on the DO instance. */
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMITS = { attendance: 30, score: 120, cancel: 5 } as const
type RateLimitClass = keyof typeof RATE_LIMITS

function rateLimitClass(operation: string): RateLimitClass {
  if (operation === 'cancel' || operation === 'cancelSeries') return 'cancel'
  if (operation === 'startMatch' || operation === 'scorePoint' || operation === 'reviewResult') return 'score'
  return 'attendance'
}

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
  status: 'open' | 'finalizing' | 'finalized' | 'cancelled'
  finalizedOptionId: string
  baseStartsAt?: string
  preparedStartsAt?: string
  preparedRevision?: number
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

type PollFinalization = Extract<RallyCommand, { operation: 'finalizePoll' }>
type ResultRecovery = Extract<ScoreEdit, { operation: 'reviewResult' | 'correctResult' }>
interface RecoveryHooks {
  poll(command: PollFinalization): Promise<void>
  result(command: ResultRecovery): Promise<void>
}
const RECOVERY_DELAY_MS = 30_000

async function applyCommand(command: RallyCommand, tool: RecordTool, recovery: RecoveryHooks): Promise<RallyCommandResult> {
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
    if (session.pendingResult) return failure('Complete the pending result update before cancelling.')
    const activePoll = await checkPendingPoll(tool, command.sessionId, command.userId)
    if (activePoll !== false) return failure('The session schedule must finish updating before cancellation.')


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

  if (command.operation === 'startMatch' || command.operation === 'scorePoint' || command.operation === 'reviewResult' || command.operation === 'correctResult') {
    return applyScoreEdit(command, session, tool, recovery.result)
  }

  if (command.operation === 'createPoll' || command.operation === 'castVote' ||
      command.operation === 'withdrawVote' || command.operation === 'cancelPoll' ||
      command.operation === 'finalizePoll') {
    return applyPollCommand(command, session, tool, recovery.poll)
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

async function checkPendingPoll(tool: RecordTool, sessionId: string, userId: string): Promise<boolean | null> {
  const result = await tool<QueryActionData<RallyPoll>>('records.query', {
    collection: 'polls', where: { sessionId, status: 'finalizing' }, limit: 1,
  }, userId)
  return result.success ? result.data.records.length > 0 : null
}

async function applyPollCommand(
  command: PollCommand,
  session: RallySession,
  tool: RecordTool,
  armPollRecovery: (command: PollFinalization) => Promise<void>,
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
        data: { sessionId, options: serializePollOptions(options), status: 'open', baseStartsAt: session.startsAt, finalizedOptionId: '', tally: '{}' },
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
    if (pollData.status === 'finalized' || pollData.status === 'finalizing') return failure('This poll is closed.')
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
  if (command.operation !== 'finalizePoll') return failure('Invalid poll command.')
  if (session.hostId !== userId) return failure('Only the session host can finalise a poll.')
  if (pollData.status === 'finalized' && pollData.finalizedOptionId === command.optionId) {
    return { success: true, data: { recordId: sessionId } }
  }
  if (pollData.status !== 'open' && pollData.status !== 'finalizing') return failure('This poll is not open.')
  const chosen = options.find(option => option.id === command.optionId)
  if (!chosen) return failure('That time is not part of this poll.')
  if (pollData.status === 'open') {
    if (pollData.baseStartsAt && Date.parse(pollData.baseStartsAt) !== Date.parse(session.startsAt)) {
      return failure('The session time changed after this poll opened.')
    }
    if (Date.parse(chosen.startsAt) <= Date.now()) return failure('The proposed time is no longer in the future.')
    await armPollRecovery(command)
    const prepared = await tool<MutateActionData>('records.update', {
      collection: 'polls', recordId: command.pollId,
      data: { status: 'finalizing', finalizedOptionId: command.optionId,
        preparedStartsAt: session.startsAt, preparedRevision: session.scheduleRevision ?? 0 },
    }, userId)
    if (!prepared.success) return failure('The poll could not start finalizing. Try again.')
  } else if (pollData.finalizedOptionId !== command.optionId) {
    return failure('Another time is already being confirmed.')
  }
  if (pollData.status === 'finalizing' && pollData.preparedStartsAt &&
      Date.parse(session.startsAt) !== Date.parse(chosen.startsAt) &&
      (Date.parse(session.startsAt) !== Date.parse(pollData.preparedStartsAt) ||
        (session.scheduleRevision ?? 0) !== pollData.preparedRevision)) {
    return failure('The session was edited during poll finalization. Its time was preserved.')
  }
  // A retry after the session write may find the chosen time already persisted.
  if (Date.parse(session.startsAt) !== Date.parse(chosen.startsAt)) {
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
  }
  try {
    const pages = recordPages<RallyRSVP>(offset =>
      tool<QueryActionData<RallyRSVP>>('records.query', {
        collection: 'rsvps', where: { sessionId }, orderBy: 'createdAt', orderDir: 'asc', limit: 100, offset,
      }, userId),
    )
    for await (const records of pages) {
      for (const { data: { userId: recipientId } } of records) {
        if (recipientId === userId) continue
        const emitted = await emitNotification(tool, {
          recipientId,
          type: 'schedule_changed',
          sessionId,
          title: `New time: ${session.title}`,
          body: `${session.title} moved to ${chosen.startsAt}. Your RSVP carries over.`,
          link: `/rallies?session=${sessionId}`,
          idempotencyKey: scheduleChangedKey(sessionId, chosen.startsAt, recipientId),
        })
        if (emitted === 'failed') return failure('Participants could not be notified. Retry the same time.')
      }
    }
  } catch {
    return failure('Participants could not be notified. The queued update will retry.')
  }
  const updatedPoll = await tool<MutateActionData>(
    'records.update',
    { collection: 'polls', recordId: command.pollId, data: { status: 'finalized' } },
    userId,
  )
  if (!updatedPoll.success) return failure('The poll could not be finalised. Retry the same time.')
  return { success: true, data: { recordId: sessionId } }
}

async function applyScoreEdit(command: ScoreEdit, session: RallySession, tool: RecordTool, armResultRecovery: RecoveryHooks['result']): Promise<RallyCommandResult> {
  if (command.operation !== 'reviewResult' && session.hostId !== command.userId) return failure('Only the session host can edit the score.')
  if (session.status !== 'open') return failure('This session is closed.')

  const current = readMatchScore(session.matchScore)
  const operationKey = command.operation === 'reviewResult' || command.operation === 'correctResult'
    ? JSON.stringify([command.operation, command.userId, current?.revision,
      command.operation === 'reviewResult' ? command.decision : [command.winner, command.sets]])
    : ''
  if (session.pendingResult && session.pendingResult !== operationKey) {
    return failure('Another result update is pending. Retry the original update.')
  }
  async function prepareResult(): Promise<boolean> {
    if (session.pendingResult) return true
    if (command.operation !== 'reviewResult' && command.operation !== 'correctResult') return false
    await armResultRecovery(command)
    const prepared = await tool<MutateActionData>('records.update', {
      collection: 'sessions', recordId: command.sessionId, data: { pendingResult: operationKey },
    }, command.userId)
    return prepared.success
  }

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
    if (command.revision !== undefined && current?.revision !== command.revision) {
      return failure('The score changed. Check the latest score before trying again.')
    }
    if (command.decision === 'approve' && !current?.disputed && current?.approvals.includes(command.userId)) {
      return { success: true, data: { recordId: command.sessionId } }
    }
    next = current && reviewResult(current, command.userId, command.decision)
    if (!next) return failure('This result is closed or unavailable for your review.')
    if (current && isFinalTransition(current, next)) {
      if (!await prepareResult()) return failure('The result update could not be started. Try again.')
      const finalized = await applyFinalization(tool, session, command.sessionId, next, command.userId)
      if (!finalized.ok) return failure('The result could not be finalized. Retry your approval.')
    }
    if (next.disputed && !current?.disputed) {
      if (!await prepareResult()) return failure('The dispute could not be started. Try again.')
      const audited = await writeAudit(tool, command.sessionId, command.userId, 'disputed', {
        sets: next.sets, winner: next.winner, revision: next.revision,
      }, next.revision)
      if (!audited) return failure('The dispute could not be audited. Retry your dispute.')
    }
  } else if (command.operation === 'correctResult') {
    if (!current) return failure('There is no result to correct.')
    if (current.revision !== command.revision) return failure('The score changed. Check the latest score before trying again.')
    const previousStatus = resultStatus(current)
    if (previousStatus !== 'final' && previousStatus !== 'disputed') {
      return failure('Only a finalized or disputed result can be corrected.')
    }
    const invalid = validateCorrectedSets(command.sets, command.winner)
    if (invalid) return failure(invalid)
    next = correctResult(current, command.sets, command.winner)
    if (!next) return failure('This result cannot be corrected.')
    if (!await prepareResult()) return failure('The correction could not be started. Try again.')
    const audited = await writeAudit(tool, command.sessionId, command.userId, 'corrected', {
      previousSets: current.sets, previousWinner: current.winner, previousRevision: current.revision,
      sets: next.sets, winner: next.winner, revision: next.revision,
    }, next.revision)
    if (!audited) return failure('The correction could not be audited. Retry the same correction.')
  } else {
    if (!current || current.winner !== null) return failure('There is no active scoreboard.')
    if (current.revision !== command.revision) return failure('The score changed. Check the latest score before trying again.')
    next = awardPoint(current, command.side)
  }

  const result = await tool<MutateActionData>('records.update', {
    collection: 'sessions',
    recordId: command.sessionId,
    data: { matchScore: JSON.stringify(next), pendingResult: '' },
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
  private rateLimits = new Map<string, { count: number; windowStart: number }>()
  private clock: () => number

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
    // Injectable clock for tests (defaults to Date.now). The platform
    // constructs DOs with (state, env); the third argument is optional.
    clock: () => number = Date.now,
  ) {
    this.clock = clock
  }

  fetch(request: Request): Promise<Response> {
    if (request.method === 'POST' && new URL(request.url).pathname === '/geocode') {
      // K05: an unexpected throw in geocoding answers 502, never a bare 500.
      return this.geocode(request).catch(() =>
        Response.json({ error: 'Place search is unavailable.' }, { status: 502 }),
      )
    }
    // K05: an unexpected throw inside the queued handler answers with the
    // same generic failure the action returns when the room is unreachable,
    // and the queue keeps processing the next command.
    const result = this.queue.then(() => this.handle(request).catch(() =>
      Response.json(failure('The session service is temporarily unavailable. Try again.')),
    ))
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  /**
   * K03: fixed-window per-user, per-session rate limit. Returns true when
   * the command may proceed. Budgets are deliberately generous for
   * legitimate use (a fast match scores well under 120 points/minute; a
   * user toggling RSVP 30 times a minute is flapping). Counters live in
   * memory on this DO instance: object eviction resets them, which is
   * acceptable for abuse mitigation — the action's Bearer verification
   * remains the auth boundary. Malformed commands never reach this check,
   * so garbage cannot consume another user's budget.
   */
  private checkRateLimit(userId: string, sessionId: string, operation: string): boolean {
    const rateClass = rateLimitClass(operation)
    const key = `${userId}:${sessionId}:${rateClass}`
    const now = this.clock()
    const entry = this.rateLimits.get(key)
    if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
      this.rateLimits.set(key, { count: 1, windowStart: now })
      return true
    }
    if (entry.count >= RATE_LIMITS[rateClass]) return false
    entry.count++
    return true
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

    // K05: bounded body read — an oversized body is rejected before parsing,
    // never buffered unboundedly. Malformed JSON gets the same generic body.
    let text: string
    try {
      text = await readBoundedBodyText(request, MAX_COMMAND_BODY_BYTES)
    } catch (cause) {
      if (cause instanceof BodyTooLargeError) {
        return Response.json(failure('Invalid rally command request.'), { status: 400 })
      }
      throw cause
    }
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return Response.json(failure('Invalid rally command request.'), { status: 400 })
    }

    const command = parseCommand(body)
    const seriesCommand = command ? null : parseSeriesCommand(body)

    // K03: HTTP 200 here is deliberate — the action maps any non-2xx room
    // response to its generic "temporarily unavailable" failure, which would
    // hide the rate-limit message from the client. The JSON body carries it.
    // Series commands are limited per user + series id, never per session:
    // they carry seriesId, not sessionId, so keying them on the session
    // would dereference a null parse and throttle nothing.
    if (command && !this.checkRateLimit(command.userId, command.sessionId, command.operation)) {
      return Response.json(failure('Too many requests. Try again shortly.'))
    }
    if (seriesCommand && !this.checkRateLimit(seriesCommand.userId, seriesCommand.seriesId, seriesCommand.operation)) {
      return Response.json(failure('Too many requests. Try again shortly.'))
    }

    const tool = this.recordTool()
    if (command) {
      return Response.json(await applyCommand(command, tool, this.recoveryHooks))
    }
    if (seriesCommand) {
      return Response.json(await applySeriesCommand(seriesCommand, tool, async (sessionId, userId) => {
        const id = this.env.RALLY_COMMAND_ROOMS.idFromName(`rally:${this.env.DEEPSPACE_APP_ID}:${sessionId}`)
        const response = await this.env.RALLY_COMMAND_ROOMS.get(id).fetch(new Request('https://internal/rally-command', {
          method: 'POST',
          body: JSON.stringify({ operation: 'cancel', sessionId, userId }),
        }))
        return (await response.json() as RallyCommandResult).success
      }))
    }
    return Response.json(failure('Invalid rally command.'), { status: 400 })
  }

  private recordTool(): RecordTool {
    const recordRoom = this.env.RECORD_ROOMS.get(
      this.env.RECORD_ROOMS.idFromName(`app:${this.env.DEEPSPACE_APP_ID}`),
    )
    return async <T>(
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
  }

  private readonly recoveryHooks: RecoveryHooks = {
    poll: command => this.armRecovery('pollRecovery', command),
    result: command => this.armRecovery('resultRecovery', command),
  }

  private async armRecovery(key: string, command: PollFinalization | ResultRecovery) {
    await this.state.storage.setAlarm(Date.now() + RECOVERY_DELAY_MS)
    await this.state.storage.put(key, command)
  }

  async alarm(): Promise<void> {
    const recovery = this.queue.then(() => this.recover())
    this.queue = recovery.then(() => undefined, () => undefined)
    await recovery
  }

  private async recover(): Promise<void> {
    const storage = this.state.storage
    const pollCommand = await storage.get<PollFinalization>('pollRecovery')
    const resultCommand = await storage.get<ResultRecovery>('resultRecovery')
    if (!pollCommand && !resultCommand) return
    // The next alarm is persisted before network writes so eviction is safe.
    await storage.setAlarm(Date.now() + RECOVERY_DELAY_MS)
    const tool = this.recordTool()
    if (pollCommand) {
      const poll = await tool<GetActionData<RallyPoll>>('records.get', {
        collection: 'polls', recordId: pollCommand.pollId,
      }, pollCommand.userId)
      if (poll.success) {
        const data = poll.data.record.data
        const outstanding = data.status === 'finalizing' && data.finalizedOptionId === pollCommand.optionId
        if (!outstanding || (await applyCommand(pollCommand, tool, this.recoveryHooks)).success) {
          await storage.delete('pollRecovery')
        }
      }
    }
    if (resultCommand) {
      const session = await tool<GetActionData<RallySession>>('records.get', {
        collection: 'sessions', recordId: resultCommand.sessionId,
      }, resultCommand.userId)
      if (session.success &&
          (!session.data.record.data.pendingResult || (await applyCommand(resultCommand, tool, this.recoveryHooks)).success)) {
        await storage.delete('resultRecovery')
      }
    }
    if (!await storage.get('pollRecovery') && !await storage.get('resultRecovery')) await storage.deleteAlarm()
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
    sets: params.sets,
    winner: params.winner,
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
  | { operation: 'createSeries' | 'editSeries'; userId: string; seriesId: string; template: SeriesTemplate; startStartsAt: string; intervalWeeks: number; count: number }
  | { operation: 'generateOccurrences'; userId: string; seriesId: string }
  | { operation: 'cancelSeries'; userId: string; seriesId: string }

function parseSeriesCommand(value: unknown): SeriesCommand | null {
  if (!isRecord(value) || typeof value.userId !== 'string' || !value.userId ||
      typeof value.seriesId !== 'string' || !/^[a-z0-9_-]{1,100}$/i.test(value.seriesId)) return null
  if ((value.operation === 'createSeries' || value.operation === 'editSeries') &&
      typeof value.seriesId === 'string' && value.seriesId &&
      typeof value.startStartsAt === 'string' &&
      typeof value.intervalWeeks === 'number' && typeof value.count === 'number' &&
      isRecord(value.template)) {
    return {
      operation: value.operation,
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

async function applySeriesCommand(
  command: SeriesCommand, tool: RecordTool,
  cancelSession: (sessionId: string, userId: string) => Promise<boolean>,
): Promise<RallyCommandResult> {
  if (command.operation === 'createSeries') {
    const existing = await tool<GetActionData<RecurringSeriesRecord>>('records.get', {
      collection: 'recurringSeries', recordId: command.seriesId,
    }, command.userId)
    if (existing.success) {
      const series = existing.data.record.data
      if (series.hostId === command.userId && series.template === serializeSeriesTemplate(command.template) &&
          Date.parse(series.startStartsAt) === Date.parse(command.startStartsAt) &&
          series.intervalWeeks === command.intervalWeeks && series.count === command.count) {
        return { success: true, data: { recordId: command.seriesId } }
      }
      return failure('This series is unavailable.')
    }
    if (existing.error !== 'Record not found') return failure('The series could not be checked.')
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

  if (command.operation === 'editSeries') {
    if (series.status !== 'active') return failure('This series is not active.')
    const instances = await tool<QueryActionData<RallySession>>('records.query', {
      collection: 'sessions', where: { seriesId: command.seriesId }, limit: 1,
    }, command.userId)
    if (!instances.success) return failure('Published sessions could not be checked.')
    if (series.generatedCount || instances.data.records.length) return failure('A published series cannot be edited.')
    const problem = validateSeries(command)
    if (problem) return failure(problem)
    const updated = await tool<MutateActionData>('records.update', {
      collection: 'recurringSeries', recordId: command.seriesId,
      data: { template: serializeSeriesTemplate(command.template), startStartsAt: new Date(command.startStartsAt).toISOString(),
        intervalWeeks: command.intervalWeeks, count: command.count },
    }, command.userId)
    return updated.success
      ? { success: true, data: { recordId: command.seriesId } }
      : failure('The series could not be updated.')
  }

  if (command.operation === 'generateOccurrences') {
    if (series.status !== 'active') return failure('This series is not active.')
    if (series.generatedCount >= series.count) return { success: true, data: { recordId: command.seriesId } }
    const template = parseSeriesTemplate(series.template)
    if (!template) return failure('This series is unavailable.')
    for (let index = series.generatedCount; index < series.count; index++) {
      const startsAt = occurrenceStartsAt(series.startStartsAt, index, series.intervalWeeks)
      const occurrenceId = `series-${command.seriesId}-${index}`
      const indexed = await tool<GetActionData<RallySession>>('records.get', {
        collection: 'sessions', recordId: occurrenceId,
      }, command.userId)
      if (indexed.success && (indexed.data.record.data.seriesId !== command.seriesId ||
          indexed.data.record.data.hostId !== command.userId)) {
        return failure('The series session is unavailable.')
      }
      if (!indexed.success && indexed.error !== 'Record not found') return failure('The series session could not be checked.')
      let recordId = indexed.success ? occurrenceId : undefined
      if (!recordId) {
        const legacy = await tool<QueryActionData<RallySession>>('records.query', {
          collection: 'sessions', where: { seriesId: command.seriesId, hostId: command.userId, startsAt }, limit: 1,
        }, command.userId)
        if (!legacy.success) return failure('The series session could not be checked.')
        recordId = legacy.data.records[0]?.recordId
      }
      if (!recordId) {
        if (Date.parse(startsAt) <= Date.now()) return failure('A series occurrence is no longer in the future.')
        const created = await tool<MutateActionData>('records.create', {
          collection: 'sessions', recordId: occurrenceId,
          data: { ...template, startsAt, seriesId: command.seriesId, chatChannelId: '', status: 'open' },
        }, command.userId)
        if (!created.success) return failure('A series session could not be created.')
        recordId = created.data.recordId
      }
      const existingRsvp = await tool<QueryActionData<RallyRSVP>>('records.query', {
        collection: 'rsvps', where: { sessionId: recordId, userId: command.userId }, limit: 1,
      }, command.userId)
      if (!existingRsvp.success) return failure('The host RSVP could not be checked.')
      if (existingRsvp.data.records.length === 0) {
        const rsvp = await tool<MutateActionData>('records.create', {
          collection: 'rsvps', data: { sessionId: recordId, status: 'going' },
        }, command.userId)
        if (!rsvp.success) return failure('The host RSVP could not be saved.')
      }
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
  if (command.operation !== 'cancelSeries') return failure('Invalid scheduling command.')
  if (series.status !== 'active') return failure('This series is already cancelled.')
  const instances = await tool<QueryActionData<RallySession>>(
    'records.query',
    { collection: 'sessions', where: { seriesId: command.seriesId, status: 'open' }, limit: 50 },
    command.userId,
  )
  if (!instances.success) return failure('Series sessions could not be checked.')
  const future = instances.data.records.filter(instance => Date.parse(instance.data.startsAt) > Date.now())
  for (const instance of future) {
    if (instance.data.pendingResult ||
        await checkPendingPoll(tool, instance.recordId, command.userId) !== false) {
      return failure('A series session is still updating. Try again after it completes.')
    }
  }
  for (const instance of future) {
    if (!await cancelSession(instance.recordId, command.userId)) {
      return failure('A series session could not be cancelled. Try again.')
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
  const roomName = `rally:${env.DEEPSPACE_APP_ID}:series:${command.seriesId}`
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
