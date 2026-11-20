import { getAuthToken } from 'deepspace'
import { afterEach, expect, it, vi } from 'vitest'
import { fetchNearbyCourts, searchPlaces } from './court-discovery-client'

vi.mock('deepspace', () => ({ getAuthToken: vi.fn() }))
afterEach(() => vi.unstubAllGlobals())

it('aborts a superseded protected request even if authentication is still resolving', async () => {
  const outgoing = vi.fn()
  vi.stubGlobal('fetch', outgoing)
  vi.mocked(getAuthToken).mockResolvedValue('fixture')
  const request = new AbortController()
  const places = searchPlaces('Pittsburgh', request.signal)
  request.abort()
  await expect(places).rejects.toMatchObject({ name: 'AbortError' })
  expect(outgoing).not.toHaveBeenCalled()
})

it('forwards cancellation and sends only rounded coordinates to the court endpoint', async () => {
  vi.mocked(getAuthToken).mockResolvedValue('fixture')
  const outgoing = vi.fn(async () => Response.json({ courts: [], count: 0, attribution: 'OSM', cached: false }))
  vi.stubGlobal('fetch', outgoing)
  const request = new AbortController()
  await expect(fetchNearbyCourts({ lat: 40.442381, lng: -79.943265 }, 10, request.signal)).resolves.toMatchObject({ courts: [] })
  expect(outgoing).toHaveBeenCalledWith('/api/courts/nearby?lat=40.442&lng=-79.943&radiusKm=10', {
    headers: { Authorization: 'Bearer fixture' },
    signal: request.signal,
  })
})
