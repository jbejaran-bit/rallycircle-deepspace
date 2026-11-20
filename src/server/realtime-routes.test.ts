import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import type { AppContext } from '../../worker'
import { registerRealtimeRoutes } from './realtime-routes'

describe('Canvas WebSocket authorization', () => {
  it('rejects a connection without a verified token before opening a room', async () => {
    const app = new Hono<AppContext>()
    registerRealtimeRoutes(app)

    const response = await app.request('/ws/canvas/rally:test-app:session:session-1')

    expect(response.status).toBe(401)
  })
})
