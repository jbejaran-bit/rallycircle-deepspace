// Deterministic browser fixtures. No SDK client, credentials, or remote writes.
import { useSyncExternalStore } from 'react'

export const ROLES = ['admin', 'member']
export const ROLE_CONFIG = {}
const people: Record<string, { id: string; name: string; email: string; role: string }> = {
  alice: { id: 'alice', name: 'Alex Morgan', email: 'alex@example.test', role: 'member' },
  bob: { id: 'bob', name: 'Jordan Lee', email: 'jordan@example.test', role: 'member' },
  casey: { id: 'casey', name: 'Casey Park', email: 'casey@example.test', role: 'member' },
  drew: { id: 'drew', name: 'Drew Ellis', email: 'drew@example.test', role: 'member' },
}
const params = new URLSearchParams(location.search)
const session = {
  title: 'Saturday doubles at Schenley', format: 'Doubles', court: 'Schenley Park Tennis Courts',
  location: 'Pittsburgh, PA', startsAt: '2030-06-15T14:00:00.000Z', durationMinutes: 90,
  targetPlayers: 4, capacity: 4, level: 'Intermediate', notes: 'Bring a fresh can of tennis balls. We’ll warm up, then rotate partners.',
  hostId: 'alice', chatChannelId: 'fixture-chat', status: params.has('cancelled') ? 'cancelled' : 'open',
}
type FixtureRecord = { recordId: string; data: Record<string, unknown>; createdAt: string }
const row = (recordId: string, data: Record<string, unknown>): FixtureRecord => ({ recordId, data, createdAt: '2030-06-13T16:10:00.000Z' })
let data: Record<string, FixtureRecord[]> = {
  sessions: params.has('empty') ? [] : [row('fixture-doubles', session), row('fixture-practice', { ...session, title: 'Evening rally practice', format: 'Practice', startsAt: '2030-06-17T22:00:00.000Z', court: 'Highland Park Tennis Courts', hostId: 'bob', capacity: 6 })],
  rsvps: ['alice', 'bob', 'casey', 'drew'].map(id => row(`rsvp-${id}`, { sessionId: 'fixture-doubles', userId: id, status: 'going' })),
  waitlists: [], polls: [], profiles: [],
  messages: [row('message-1', { channelId: 'fixture-chat', authorId: 'bob', content: 'I’ll bring the balls. See you on court 2!', edited: false }), row('message-2', { channelId: 'fixture-chat', authorId: 'alice', content: 'Perfect. Let’s warm up for ten minutes before we start.', edited: false })],
}
let revision = 0
const listeners = new Set<() => void>()
const notify = () => { revision++; listeners.forEach(listener => listener()) }
function useRevision() { useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener) }, () => revision) }
export const useAuth = () => ({ userId: params.get('user') ?? 'alice', isSignedIn: true, isLoaded: true })
export const useUser = () => ({ user: people[params.get('user') ?? 'alice'], loading: false })
export const useAuthProfileReady = () => ({ ...useAuth(), ...useUser(), userLoading: false })
export const useUserLookup = () => ({ getName: (id: string) => people[id]?.name ?? 'Player', getUser: (id: string) => people[id] })
export function useQuery(collection: string, options?: { where?: Record<string, unknown> }) {
  useRevision()
  const records = (data[collection] ?? []).filter(record => Object.entries(options?.where ?? {}).every(([key, value]) => record.data[key] === value))
  return { records, status: params.has('error') ? 'error' : params.has('loading') ? 'loading' : 'ready', error: params.has('error') ? 'Local fixture connection unavailable.' : undefined }
}
export function useMessages(channelId: string) { const result = useQuery('messages', { where: { channelId } }); return { ...result, messages: result.records } }
export const usePresenceRoom = () => ({ peers: [{ userId: 'bob' }], connected: true })
export function useMutations(collection: string) {
  return { ready: true,
    createConfirmed: async (input: Record<string, unknown>) => {
      if (params.has('sendError')) throw new Error('Message could not be sent. Try again.')
      const id = `fixture-${collection}-${revision}`
      data = { ...data, [collection]: [...(data[collection] ?? []), row(id, input)] }; notify(); return id
    },
    putConfirmed: async (recordId: string, input: Record<string, unknown>) => {
      data = { ...data, [collection]: (data[collection] ?? []).map(record => record.recordId === recordId ? { ...record, data: { ...record.data, ...input } } : record) }; notify()
    },
  }
}
let shapes = ['A1', 'A2', 'B1', 'B2'].map((label, index) => ({ id: `marker-${label}`, type: 'rally-player', x: [110, 255, 110, 255][index], y: index < 2 ? 400 : 160, props: { label } }))
export function useCanvas() {
  useRevision()
  return { shapes, connected: true, canWrite: true,
    addShape: () => undefined,
    moveShape: (id: string, x: number, y: number) => { shapes = shapes.map(shape => shape.id === id ? { ...shape, x, y } : shape); notify() },
    deleteShape: (id: string) => { shapes = shapes.filter(shape => shape.id !== id); notify() },
  }
}
export const getAuthToken = async () => 'local-fixture-token-never-remote'
export const signIn = { email: async () => ({ error: { message: 'No fixture sign-in.' } }) }
export const signOut = async () => undefined
const refuseIntegration = async () => { throw new Error('Integrations are disabled in local UI fixtures.') }
export const integration = { call: refuseIntegration, post: refuseIntegration, delete: refuseIntegration }
export const getGoogleConnection = async () => ({ connected: false, scopes: [] })
export const connectGoogle = async () => { throw new Error('OAuth is disabled in local UI fixtures.') }

export function applyFixtureAction(action: string, input: Record<string, unknown>) {
  const userId = params.get('user') ?? 'alice'
  if (action === 'createRally') {
    data = { ...data, sessions: [...data.sessions, row('fixture-created', { ...input, hostId: userId, status: 'open', chatChannelId: '' })] }
    notify(); return 'fixture-created'
  }
  const membership = (record: FixtureRecord) => record.data.sessionId === input.sessionId && record.data.userId === userId
  if (input.operation === 'rsvp') data = { ...data, rsvps: [...data.rsvps.filter(record => !membership(record)), row(`rsvp-${userId}`, { sessionId: input.sessionId, userId, status: input.status })] }
  if (input.operation === 'withdraw') data = { ...data, rsvps: data.rsvps.filter(record => !membership(record)) }
  if (input.operation === 'joinWaitlist') data = { ...data, waitlists: [...data.waitlists, row(`waitlist-${userId}`, { sessionId: input.sessionId, userId })] }
  if (input.operation === 'leaveWaitlist') data = { ...data, waitlists: data.waitlists.filter(record => !membership(record)) }
  notify(); return String(input.sessionId)
}

// Keep Playwright on the same module instance consumed by the React hooks.
// Importing a bare SDK alias again can create a separate optimizer module.
Object.assign(globalThis, { __rallycircleFixtureAction: applyFixtureAction })
