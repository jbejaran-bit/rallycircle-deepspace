import type { Env } from '../../worker.js'

type AccessRole = 'member' | 'viewer'
type AccessResult =
  | { kind: 'authorized'; role: AccessRole }
  | { kind: 'denied' }
  | { kind: 'unavailable' }

type InternalToolResult =
  | { kind: 'success'; data: Record<string, unknown> }
  | { kind: 'failed' }
  | { kind: 'unavailable' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function executeRecordTool(
  env: Env,
  tool: 'records.get' | 'records.query',
  params: Record<string, unknown>,
): Promise<InternalToolResult> {
  const namespace = env.RECORD_ROOMS
  const stub = namespace.get(namespace.idFromName(`app:${env.DEEPSPACE_APP_ID}`))

  try {
    const response = await stub.fetch(
      new Request('https://internal/api/tools/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': env.OWNER_USER_ID,
          'X-App-Action': 'true',
        },
        body: JSON.stringify({ tool, params }),
      }),
    )
    if (!response.ok) {
      console.error('Courtboard authorization lookup failed', response.status)
      return { kind: 'unavailable' }
    }

    const payload: unknown = await response.json()
    if (!isRecord(payload)) return { kind: 'unavailable' }
    if (payload.success !== true) return { kind: 'failed' }
    if (!isRecord(payload.data)) return { kind: 'unavailable' }

    return { kind: 'success', data: payload.data }
  } catch (error) {
    console.error('Courtboard authorization lookup failed', error)
    return { kind: 'unavailable' }
  }
}

export async function getRallyCanvasAccess(
  env: Env,
  sessionId: string,
  userId: string,
): Promise<AccessResult> {
  const sessionLookup = await executeRecordTool(env, 'records.get', {
    collection: 'sessions',
    recordId: sessionId,
  })
  if (sessionLookup.kind === 'unavailable') return sessionLookup
  if (sessionLookup.kind === 'failed') return { kind: 'denied' }

  const record = sessionLookup.data.record
  if (!isRecord(record) || !isRecord(record.data)) return { kind: 'denied' }

  const session = record.data
  if (
    typeof session.hostId !== 'string' ||
    (session.status !== 'open' && session.status !== 'cancelled')
  ) {
    return { kind: 'denied' }
  }

  const isHost = session.hostId === userId
  if (!isHost) {
    const rsvpLookup = await executeRecordTool(env, 'records.query', {
      collection: 'rsvps',
      where: { sessionId, userId },
      limit: 1,
    })
    if (rsvpLookup.kind !== 'success') {
      return rsvpLookup.kind === 'failed' ? { kind: 'unavailable' } : rsvpLookup
    }

    const records = rsvpLookup.data.records
    if (!Array.isArray(records)) return { kind: 'unavailable' }
    const isParticipant = records.some((item) => {
      if (!isRecord(item) || !isRecord(item.data)) return false
      return (
        item.data.sessionId === sessionId &&
        item.data.userId === userId &&
        (item.data.status === 'going' || item.data.status === 'maybe')
      )
    })
    if (!isParticipant) return { kind: 'denied' }
  }

  return {
    kind: 'authorized',
    role: session.status === 'open' ? 'member' : 'viewer',
  }
}
