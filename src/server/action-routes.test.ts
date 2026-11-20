import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { AppContext } from '../../worker'
import { registerActionRoutes } from './action-routes'

function createApp(authenticated: boolean) {
  const app = new Hono<AppContext>()
  const resolveAuth: Parameters<typeof registerActionRoutes>[1] = vi.fn(async () =>
    authenticated ? { userId: 'fixture-user' } as Awaited<ReturnType<Parameters<typeof registerActionRoutes>[1]>> : null,
  )
  registerActionRoutes(app, resolveAuth)
  return app
}

function post(app: ReturnType<typeof createApp>, body: string, authorization = 'Bearer fixture-token') {
  return app.request('/api/actions/rallyCommand', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authorization },
    body,
  })
}

describe('action HTTP boundary', () => {
  it('rejects signed-out requests before parsing the body', async () => {
    const response = await post(createApp(false), '{')
    expect(response.status).toBe(401)
  })

  it('requires a bearer session even when cookie identity resolved', async () => {
    const response = await post(createApp(true), '{}', '')
    expect(response.status).toBe(401)
  })

  it.each(['{', 'null', '[]', '"command"', '23'])('rejects a non-object body %s', async body => {
    const response = await post(createApp(true), body)
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Action parameters must be a JSON object.',
    })
  })
})
