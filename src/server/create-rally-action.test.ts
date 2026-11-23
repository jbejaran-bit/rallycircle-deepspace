import type { ActionTools } from 'deepspace/worker'
import { expect, it, vi } from 'vitest'
import type { Env } from '../../worker.js'
import { createRallyAction } from './create-rally-action.js'
import { serializeRallyPlace, type RallyPlace } from '../lib/rally-place.js'

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
  const requests: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = []
  const roomFetch = vi.fn(async (request: Request) => {
    const headers: Record<string, string> = {}
    request.headers.forEach((value, key) => { headers[key] = value })
    requests.push({
      url: request.url,
      method: request.method,
      headers,
      body: await request.json(),
    })
    return Response.json({ success: true, data: { recordId: 'session-1' } })
  })
  const env = {
    DEEPSPACE_APP_ID: 'test-app',
    RALLY_COMMAND_ROOMS: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: roomFetch }),
    },
  } as unknown as Env
  const createRally = (params: Record<string, unknown>) => createRallyAction({
    userId: 'host', params, tools: { create } as unknown as ActionTools, env, callerJwt: 'test-token',
  })
  return { create, roomFetch, requests, createRally }
}

it('forwards a validated draft to the host’s creation room and returns its session', async () => {
  const { create, roomFetch, requests, createRally } = harness()
  const input = draft()
  await expect(createRally(input)).resolves.toEqual({ success: true, data: { recordId: 'session-1' } })
  // The action itself never writes a session directly: serialization and
  // dedup live in the per-user command room.
  expect(create).not.toHaveBeenCalled()
  expect(roomFetch).toHaveBeenCalledTimes(1)
  expect(requests).toHaveLength(1)
  expect(requests[0].method).toBe('POST')
  expect(requests[0].url).toBe('https://internal/rally-command')
  // Marker header: the room's internal-action check (K01 fix) must accept
  // this call, and the room name scopes serialization to this host.
  expect(requests[0].headers['x-app-action']).toBe('true')
  expect(requests[0].body).toEqual({
    operation: 'createRally',
    userId: 'host',
    draft: { ...input, title: 'Evening rally', startsAt: input.startsAt },
  })
})

it.each([
  { startsAt: '2020-01-01T12:00:00Z' },
  { hostId: 'someone-else' },
  { scheduleRevision: 42 },
  { seriesId: 'other-series' },
  { targetPlayers: 4, capacity: 2 },
])('rejects an invalid or privileged draft field before any room call or storage write', async (patch) => {
  const { create, roomFetch, createRally } = harness()
  await expect(createRally({ ...draft(), ...patch })).resolves.toMatchObject({ success: false })
  expect(roomFetch).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
})

it('fails closed when the command-room binding is missing instead of creating directly', async () => {
  const create = vi.fn(async () => ({ success: true, data: { recordId: 'session-1' } }))
  const result = await createRallyAction({
    userId: 'host', params: draft(), tools: { create } as unknown as ActionTools,
    env: {} as Env, callerJwt: 'test-token',
  })
  expect(result).toMatchObject({ success: false })
  expect(create).not.toHaveBeenCalled()
})

it('validates and forwards canonical selected-place JSON without inventing coordinates for text-only drafts', async () => {
  const { requests, createRally } = harness()
  const place: RallyPlace = { lat: 35.6895, lng: 139.6917, id: 'osm:node/1', name: 'Public courts', address: 'Tokyo, Japan', source: 'osm' }
  const courtPlace = JSON.stringify({ source: place.source, address: place.address, name: place.name, id: place.id, lng: place.lng, lat: place.lat })
  await expect(createRally({ ...draft(), courtPlace })).resolves.toMatchObject({ success: true })
  expect((requests[0].body as { draft: { courtPlace: string } }).draft.courtPlace).toBe(serializeRallyPlace(place))
})

it.each([
  '{bad', JSON.stringify({ lat: 95, lng: 0 }), 'x'.repeat(1201),
])('rejects malformed selected places before requesting persistence: %s', courtPlace => {
  const { roomFetch, createRally } = harness()
  return createRally({ ...draft(), courtPlace }).then(result => {
    expect(result.success).toBe(false)
    expect(roomFetch).not.toHaveBeenCalled()
  })
})
