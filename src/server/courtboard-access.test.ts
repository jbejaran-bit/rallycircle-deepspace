import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../../worker'
import { getRallyCanvasAccess } from './courtboard-access'

function makeEnv(
  session: { hostId: string; status: 'open' | 'cancelled' },
  rsvps: Array<{ sessionId: string; userId: string; status: 'going' | 'maybe' }>,
  failTool?: 'records.get' | 'records.query',
) {
  const fetch = vi.fn(async (request: Request) => {
    const { tool, params } = await request.json() as {
      tool: string
      params: { collection: string; recordId?: string; where?: Record<string, string>; limit?: number }
    }
    if (tool === failTool) return Response.json({ success: false, error: 'unavailable' })
    if (tool === 'records.get' && params.collection === 'sessions') {
      return Response.json({
        success: true,
        data: { record: { recordId: params.recordId, data: session } },
      })
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
})
