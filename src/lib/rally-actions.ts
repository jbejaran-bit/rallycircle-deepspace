import { getAuthToken } from 'deepspace'
import type { RSVPStatus } from './rally'

type RallyCommand =
  | { operation: 'rsvp'; sessionId: string; status: RSVPStatus }
  | { operation: 'cancel'; sessionId: string }
  | { operation: 'withdraw'; sessionId: string }

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
  const token = await getAuthToken()
  if (!token) throw new Error('Sign in before updating this session.')

  const response = await fetch('/api/actions/rallyCommand', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  })
  const result: unknown = await response.json()
  if (!isRallyCommandResponse(result)) {
    throw new Error('The session update returned an invalid response.')
  }
  if (!response.ok || !result.success) {
    throw new Error(result.error ?? 'The session update was rejected.')
  }
}
