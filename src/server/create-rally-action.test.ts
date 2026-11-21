import type { ActionTools } from 'deepspace/worker'
import { expect, it, vi } from 'vitest'
import type { Env } from '../../worker.js'
import { createRallyAction } from './create-rally-action.js'

const draft = () => ({
  format: 'Singles',
  title: ' Evening rally ',
  court: 'Public courts',
  location: 'Pittsburgh',
  startsAt: new Date(Date.now() + 86_400_000).toISOString(),
  durationMinutes: 90,
  targetPlayers: 2,
  level: 'All levels',
  notes: '',
})

function harness() {
  const create = vi.fn(async () => ({ success: true, data: { recordId: 'session-1' } }))
  const createRally = (params: Record<string, unknown>) => createRallyAction({
    userId: 'host', params, tools: { create } as unknown as ActionTools, env: {} as Env, callerJwt: 'test-token',
  })
  return { create, createRally }
}

it('creates an open rally with game details and leaves identity stamping to the authenticated record tool', async () => {
  const { create, createRally } = harness()
  const input = draft()
  await expect(createRally(input)).resolves.toEqual({ success: true, data: { recordId: 'session-1' } })
  expect(create).toHaveBeenCalledWith('sessions', { ...input, title: 'Evening rally', status: 'open', chatChannelId: '' })
})

it.each([
  { startsAt: '2020-01-01T12:00:00Z' },
  { hostId: 'someone-else' },
  { scheduleRevision: 42 },
  { seriesId: 'other-series' },
  { targetPlayers: 4, capacity: 2 },
])('rejects an invalid or privileged draft field before any storage write', async (patch) => {
  const { create, createRally } = harness()
  await expect(createRally({ ...draft(), ...patch })).resolves.toMatchObject({ success: false })
  expect(create).not.toHaveBeenCalled()
})
