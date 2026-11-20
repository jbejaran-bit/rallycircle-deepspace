import { getAuthToken } from 'deepspace'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runRallyCommand } from './rally-actions'

vi.mock('deepspace', () => ({ getAuthToken: vi.fn() }))

const command = { operation: 'rsvp', sessionId: 'test-session', status: 'going' } as const
const request = vi.fn<typeof fetch>()

beforeEach(() => {
  vi.mocked(getAuthToken).mockResolvedValue('fixture-token')
  request.mockReset()
  vi.stubGlobal('fetch', request)
})

afterEach(() => vi.unstubAllGlobals())

describe('Rally command client', () => {
  it('sends the command with the current bearer session', async () => {
    request.mockResolvedValue(Response.json({ success: true, data: { recordId: 'rsvp' } }))
    await expect(runRallyCommand(command)).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledExactlyOnceWith('/api/actions/rallyCommand', {
      method: 'POST',
      headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    })
  })

  it('requires sign-in without sending an anonymous request', async () => {
    vi.mocked(getAuthToken).mockResolvedValue(null)
    await expect(runRallyCommand(command)).rejects.toThrow('Sign in before updating this session.')
    expect(request).not.toHaveBeenCalled()
  })

  it('reports expired authentication from the worker', async () => {
    request.mockResolvedValue(Response.json({ error: 'Unauthorized' }, { status: 401 }))
    await expect(runRallyCommand(command)).rejects.toThrow('Sign in before updating this session.')
  })

  it('preserves a server-side domain rejection', async () => {
    request.mockResolvedValue(Response.json({ success: false, error: 'This session is not open for responses.' }))
    await expect(runRallyCommand(command)).rejects.toThrow('This session is not open for responses.')
  })

  it('provides a retry message for a non-JSON gateway failure', async () => {
    request.mockResolvedValue(new Response('Service unavailable', { status: 503 }))
    await expect(runRallyCommand(command)).rejects.toThrow('The session update could not be completed. Try again.')
  })

  it('rejects a success response without a record ID', async () => {
    request.mockResolvedValue(Response.json({ success: true, data: {} }))
    await expect(runRallyCommand(command)).rejects.toThrow('The session update returned an invalid response.')
  })
})
