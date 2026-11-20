import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../../worker'
import { getRallyCanvasAccess } from './courtboard-access'

function makeEnv(
  session:
    | { hostId: string; status: 'open' | 'cancelled' }
    | Record<string, { hostId: string; status: 'open' | 'cancelled' }>,
  rsvps: Array<{ sessionId: string; userId: string; status: 'going' | 'maybe' }>,
  failTool?: 'records.get' | 'records.query',
) {
  // Single-session form keeps the old call sites working; the map form lets
  // K06 tests put two sessions behind one env.
  const sessionsById: Record<string, { hostId: string; status: 'open' | 'cancelled' }> =
    'hostId' in session ? { 'session-1': session } : session
  const fetch = vi.fn(async (request: Request) => {
    const { tool, params } = await request.json() as {
      tool: string
      params: { collection: string; recordId?: string; where?: Record<string, string>; limit?: number }
    }
    if (tool === failTool) return Response.json({ success: false, error: 'unavailable' })
    if (tool === 'records.get' && params.collection === 'sessions') {
      const found = sessionsById[String(params.recordId)]
      return found
        ? Response.json({
          success: true,
          data: { record: { recordId: params.recordId, data: found } },
        })
        : Response.json({ success: false, error: 'Record not found' })
    }
    if (tool === 'records.query' && params.collection === 'rsvps') {
      const records = rsvps
        .filter((rsvp) => rsvp.sessionId === params.where?.sessionId && rsvp.userId === params.where?.userId)
        .slice(0, params.limit)
        .map((data, index) => ({ recordId: `rsvp-${index}`, data }))
      return Response.json({ success: true, data: { records, count: records.length } })
    }
    return Response.json({ success: false, error: 'unexpected request' })
  })

  const env = {
    DEEPSPACE_APP_ID: 'rally-test-app',
    OWNER_USER_ID: 'app-owner',
    RECORD_ROOMS: {
      idFromName: (name: string) => name,
      get: () => ({ fetch }),
    },
  } as unknown as Env

  return { env, fetch }
}

describe('Rally Canvas access', () => {
  it('lets the host write without requiring a redundant RSVP', async () => {
    const { env } = makeEnv({ hostId: 'host', status: 'open' }, [])

    await expect(getRallyCanvasAccess(env, 'session-1', 'host')).resolves.toEqual({
      kind: 'authorized',
      role: 'member',
    })
  })

  it('lets only an RSVP participant read and write an open session board', async () => {
    const { env } = makeEnv(
      { hostId: 'host', status: 'open' },
      [{ sessionId: 'session-1', userId: 'player', status: 'going' }],
    )

    await expect(getRallyCanvasAccess(env, 'session-1', 'player')).resolves.toEqual({
      kind: 'authorized',
      role: 'member',
    })
    await expect(getRallyCanvasAccess(env, 'session-1', 'stranger')).resolves.toEqual({
      kind: 'denied',
    })
  })

  it('keeps cancelled boards readable but not writable to session participants', async () => {
    const { env } = makeEnv(
      { hostId: 'host', status: 'cancelled' },
      [{ sessionId: 'session-1', userId: 'player', status: 'maybe' }],
    )

    await expect(getRallyCanvasAccess(env, 'session-1', 'player')).resolves.toEqual({
      kind: 'authorized',
      role: 'viewer',
    })
    await expect(getRallyCanvasAccess(env, 'session-1', 'host')).resolves.toEqual({
      kind: 'authorized',
      role: 'viewer',
    })
  })

  it('fails closed when the session or RSVP authorization lookup fails', async () => {
    const sessionFailure = makeEnv({ hostId: 'host', status: 'open' }, [], 'records.get')
    await expect(getRallyCanvasAccess(sessionFailure.env, 'session-1', 'host')).resolves.toEqual({
      kind: 'denied',
    })

    const rsvpFailure = makeEnv({ hostId: 'host', status: 'open' }, [], 'records.query')
    await expect(getRallyCanvasAccess(rsvpFailure.env, 'session-1', 'player')).resolves.toEqual({
      kind: 'unavailable',
    })
  })

  it('denies a signed-in user whose RSVP belongs to a different session (K06)', async () => {
    const { env } = makeEnv(
      {
        'session-1': { hostId: 'host', status: 'open' },
        'session-2': { hostId: 'other-host', status: 'open' },
      },
      [{ sessionId: 'session-1', userId: 'player', status: 'going' }],
    )

    // Own session: authorized. The other session, same user: denied — an
    // RSVP to one session is never a ticket to another session's board.
    await expect(getRallyCanvasAccess(env, 'session-1', 'player')).resolves.toEqual({
      kind: 'authorized',
      role: 'member',
    })
    await expect(getRallyCanvasAccess(env, 'session-2', 'player')).resolves.toEqual({
      kind: 'denied',
    })
    await expect(getRallyCanvasAccess(env, 'session-2', 'other-host')).resolves.toEqual({
      kind: 'authorized',
      role: 'member',
    })
  })

  it('denies an unknown session id (K06)', async () => {
    const { env } = makeEnv({ hostId: 'host', status: 'open' }, [
      { sessionId: 'session-1', userId: 'player', status: 'going' },
    ])

    await expect(getRallyCanvasAccess(env, 'no-such-session', 'player')).resolves.toEqual({
      kind: 'denied',
    })
    await expect(getRallyCanvasAccess(env, 'no-such-session', 'host')).resolves.toEqual({
      kind: 'denied',
    })
  })

  it('re-evaluates access on every call, so revocation takes effect immediately (K06)', async () => {
    const rsvps: Array<{ sessionId: string; userId: string; status: 'going' | 'maybe' }> = [
      { sessionId: 'session-1', userId: 'player', status: 'going' },
    ]
    const { env } = makeEnv({ hostId: 'host', status: 'open' }, rsvps)

    // Per-message re-authorization in AppCanvasRoom.onMessage depends on
    // this: no cached verdict, a fresh record lookup per call.
    await expect(getRallyCanvasAccess(env, 'session-1', 'player')).resolves.toEqual({
      kind: 'authorized',
      role: 'member',
    })
    rsvps.length = 0 // the player withdraws
    await expect(getRallyCanvasAccess(env, 'session-1', 'player')).resolves.toEqual({
      kind: 'denied',
    })
  })
})
