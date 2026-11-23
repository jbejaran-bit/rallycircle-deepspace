import { getAuthToken } from 'deepspace'
import type { MatchTeams, ScoreSide } from './rally-score'
import type { RallySession, RSVPStatus } from './rally'
import type { PollOptionInput } from './polls'
import type { SeriesTemplate } from './recurrence'
import type { RallyDetailsSnapshot } from './rally-place'

type RallyCommand =
  | { operation: 'editDetails'; sessionId: string; details: RallyDetailsSnapshot; expected: RallyDetailsSnapshot }
  | { operation: 'rsvp'; sessionId: string; status: RSVPStatus }
  | { operation: 'withdraw' | 'joinWaitlist' | 'leaveWaitlist'; sessionId: string }
  | { operation: 'cancel'; sessionId: string }
  | { operation: 'createPoll'; sessionId: string; options: PollOptionInput[] }
  | { operation: 'castVote' | 'withdrawVote'; sessionId: string; pollId: string; optionId: string }
  | { operation: 'cancelPoll'; sessionId: string; pollId: string }
  | { operation: 'finalizePoll'; sessionId: string; pollId: string; optionId: string }
  | { operation: 'reviewResult'; sessionId: string; decision: 'approve' | 'dispute'; revision?: number }
  | { operation: 'correctResult'; sessionId: string; revision: number; sets: Array<[number, number]>; winner: ScoreSide }
  | { operation: 'startMatch'; sessionId: string; teams: MatchTeams }
  | { operation: 'scorePoint'; sessionId: string; side: ScoreSide; revision: number }

interface RallyCommandResponse {
  success: boolean
  data?: { recordId: string }
  error?: string
}

function isRallyCommandResponse(value: unknown): value is RallyCommandResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  return (
    (result.success === true &&
      typeof result.data === 'object' &&
      result.data !== null &&
      !Array.isArray(result.data) &&
      typeof (result.data as Record<string, unknown>).recordId === 'string') ||
    (result.success === false && typeof result.error === 'string')
  )
}

export async function runRallyCommand(command: RallyCommand): Promise<void> {
  await sendRallyAction('rallyCommand', command)
}

type RallyDraft = Pick<RallySession, 'format' | 'title' | 'court' | 'location' | 'startsAt' |
  'durationMinutes' | 'targetPlayers' | 'capacity' | 'level' | 'notes' | 'courtPlace'>

export function createRally(draft: RallyDraft): Promise<string> {
  return sendRallyAction('createRally', draft)
}

async function sendRallyAction(action: 'rallyCommand' | 'createRally', input: RallyCommand | RallyDraft): Promise<string> {
  const token = await getAuthToken()
  if (!token) throw new Error('Sign in before updating this session.')

  const response = await fetch(`/api/actions/${action}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  })
  if (response.status === 401) throw new Error('Sign in before updating this session.')

  const result: unknown = await response.json().catch(() => null)
  if (!response.ok && !isRallyCommandResponse(result)) {
    throw new Error('The session update could not be completed. Try again.')
  }
  if (!isRallyCommandResponse(result)) {
    throw new Error('The session update returned an invalid response.')
  }
  if (!response.ok || !result.success) {
    throw new Error(result.error ?? 'The session update was rejected.')
  }
  return result.data!.recordId
}

type SchedulingCommand =
  | { operation: 'createSeries' | 'editSeries'; seriesId: string; template: SeriesTemplate; startStartsAt: string; intervalWeeks: number; count: number }
  | { operation: 'generateOccurrences'; seriesId: string }
  | { operation: 'cancelSeries'; seriesId: string }

/** Runs a scheduling command and returns the affected record id (series id). */
export async function runSchedulingAction(command: SchedulingCommand): Promise<{ recordId: string }> {
  const token = await getAuthToken()
  if (!token) throw new Error('Sign in before updating this series.')

  const response = await fetch('/api/actions/scheduling', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  })
  if (response.status === 401) throw new Error('Sign in before updating this series.')

  const result: unknown = await response.json().catch(() => null)
  if (!isRallyCommandResponse(result)) {
    throw new Error('The scheduling update returned an invalid response.')
  }
  if (!response.ok || !result.success) {
    throw new Error(result.error ?? 'The scheduling update was rejected.')
  }
  return result.data as { recordId: string }
}
