import { getAuthToken } from 'deepspace'
import type { ScoreboardInput } from './scoreboard'

export interface ScoreboardCommand {
  operation: 'scoreboard'
  sessionId: string
  teamAName: string
  teamBName: string
  status: ScoreboardInput['status']
  sets: ScoreboardInput['sets']
  matchTiebreak: ScoreboardInput['matchTiebreak']
  expectedVersion: number
  correction: boolean
}

interface ScoreboardCommandResponse {
  success: boolean
  data?: { recordId: string }
  error?: string
}

function isScoreboardCommandResponse(value: unknown): value is ScoreboardCommandResponse {
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

/** True when the server rejected a save because the score changed first. */
export function isScoreboardConflict(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Conflict:')
}

/** Save a scoreboard through the server action (host-only, version-checked). */
export async function runScoreboardCommand(command: ScoreboardCommand): Promise<void> {
  const token = await getAuthToken()
  if (!token) throw new Error('Sign in before updating the scoreboard.')

  const response = await fetch('/api/actions/rallyCommand', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  })
  const result: unknown = await response.json()
  if (!isScoreboardCommandResponse(result)) {
    throw new Error('The scoreboard update returned an invalid response.')
  }
  if (!response.ok || !result.success) {
    throw new Error(result.error ?? 'The scoreboard update was rejected.')
  }
}
