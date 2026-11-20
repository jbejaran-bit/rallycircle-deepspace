import { describe, expect, it } from 'vitest'
import { groupAction } from './group-actions.js'
import { createMockStore, mockToolsFor, seedSession } from './action-test-harness.js'
import type { Env } from '../../worker.js'

function call(
  store: ReturnType<typeof createMockStore>,
  userId: string,
  params: Record<string, unknown>,
) {
  return groupAction({
    userId,
    params,
    tools: mockToolsFor(store, userId),
    env: {} as Env,
    callerJwt: 'test-token',
  })
}

async function createGroup(
  store: ReturnType<typeof createMockStore>,
  host: string,
  overrides: Record<string, unknown> = {},
) {
  const result = await call(store, host, {
    operation: 'createGroup',
    name: 'Saturday Club',
    description: 'Weekly games',
    visibility: 'public',
    ...overrides,
  })
  if (!result.success || !result.data || typeof result.data !== 'object' || !('recordId' in result.data)) {
    throw new Error(`Group creation failed: ${JSON.stringify(result)}`)
  }
  return result.data.recordId as string
}

const SESSION_FIELDS = {
  format: 'Singles',
  title: 'Saturday rally',
  court: 'Schenley Oval',
  location: 'Pittsburgh',
  startsAt: '2030-01-01T12:00:00.000Z',
  durationMinutes: 90,
  targetPlayers: 2,
  level: 'All levels',
  notes: '',
}

describe('group creation and discovery', () => {
  it('creates a group and records the creator as host', async () => {
    const store = createMockStore()
    const groupId = await createGroup(store, 'host')
    const fetched = await call(store, 'host', { operation: 'getGroup', groupId })
    expect(fetched).toMatchObject({ success: true })
    if (!fetched.success) throw new Error('Expected getGroup to succeed')
    expect(fetched.data).toMatchObject({ recordId: groupId, role: 'host' })
    expect((fetched.data as { group: { hostId: string } }).group.hostId).toBe('host')
  })

  it('rejects invalid group input', async () => {
    const store = createMockStore()
    await expect(call(store, 'host', { operation: 'createGroup', name: '', visibility: 'public' }))
      .resolves.toMatchObject({ success: false, error: expect.stringMatching(/name/) })
    await expect(call(store, 'host', { operation: 'createGroup', name: 'Club', visibility: 'secret' }))
      .resolves.toMatchObject({ success: false, error: expect.stringMatching(/public or private/) })
  })

  it('hides private groups from non-members in list and get', async () => {
    const store = createMockStore()
    const privateId = await createGroup(store, 'host', { visibility: 'private', name: 'Inner Circle' })
    const publicId = await createGroup(store, 'host', { visibility: 'public', name: 'Open Club' })

    const strangerList = await call(store, 'stranger', { operation: 'listGroups' })
    expect(strangerList.success).toBe(true)
    if (!strangerList.success) throw new Error('Expected listGroups to succeed')
    const listed = (strangerList.data as { groups: { recordId: string }[] }).groups.map(g => g.recordId)
    expect(listed).toContain(publicId)
    expect(listed).not.toContain(privateId)
    await expect(call(store, 'stranger', { operation: 'getGroup', groupId: privateId }))
      .resolves.toMatchObject({ success: false, error: 'This group is private.' })

    await expect(call(store, 'stranger', { operation: 'joinGroup', groupId: privateId }))
      .resolves.toMatchObject({ success: true })
    const memberList = await call(store, 'stranger', { operation: 'listGroups' })
    if (!memberList.success) throw new Error('Expected listGroups to succeed')
    expect((memberList.data as { groups: { recordId: string }[] }).groups.map(g => g.recordId)).toContain(privateId)
  })

  it('paginates the group list with a cursor', async () => {
    const store = createMockStore()
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      ids.push(await createGroup(store, 'host', { name: `Club ${i}` }))
    }
    const first = await call(store, 'host', { operation: 'listGroups', limit: 2 })
    expect(first.success).toBe(true)
    if (!first.success) throw new Error('Expected listGroups to succeed')
    const firstData = first.data as { groups: { recordId: string }[]; nextBeforeCreatedAt?: string }
    expect(firstData.groups).toHaveLength(2)
    expect(firstData.nextBeforeCreatedAt).toBeDefined()
    const second = await call(store, 'host', {
      operation: 'listGroups',
      limit: 2,
      beforeCreatedAt: firstData.nextBeforeCreatedAt,
    })
    if (!second.success) throw new Error('Expected listGroups to succeed')
    const secondData = second.data as { groups: { recordId: string }[] }
    expect(secondData.groups).toHaveLength(1)
    expect(new Set([...firstData.groups, ...secondData.groups].map(g => g.recordId))).toEqual(new Set(ids))
  })
})

describe('membership', () => {
  it('join is idempotent and leave is a no-op the second time', async () => {
    const store = createMockStore()
    const groupId = await createGroup(store, 'host')
    const first = await call(store, 'alice', { operation: 'joinGroup', groupId })
    const second = await call(store, 'alice', { operation: 'joinGroup', groupId })
    expect(first.success).toBe(true)
    expect(second.success).toBe(true)
    if (!first.success || !second.success) throw new Error('Expected joins to succeed')
    expect((first.data as { recordId: string }).recordId).toBe((second.data as { recordId: string }).recordId)
    expect(store.get('groupMembers')?.size).toBe(2)

    await expect(call(store, 'alice', { operation: 'leaveGroup', groupId })).resolves.toMatchObject({ success: true })
    await expect(call(store, 'alice', { operation: 'leaveGroup', groupId })).resolves.toMatchObject({ success: true })
    expect(store.get('groupMembers')?.size).toBe(1)
  })

  it('the host cannot leave without transferring hosting', async () => {
    const store = createMockStore()
    const groupId = await createGroup(store, 'host')
    await expect(call(store, 'host', { operation: 'leaveGroup', groupId }))
      .resolves.toMatchObject({ success: false, error: expect.stringMatching(/Transfer hosting/) })
  })

  it('only members can list members', async () => {
    const store = createMockStore()
    const groupId = await createGroup(store, 'host')
    await expect(call(store, 'stranger', { operation: 'listMembers', groupId }))
      .resolves.toMatchObject({ success: false })
    await call(store, 'alice', { operation: 'joinGroup', groupId })
    const listed = await call(store, 'alice', { operation: 'listMembers', groupId })
    expect(listed.success).toBe(true)
    if (!listed.success) throw new Error('Expected listMembers to succeed')
    expect((listed.data as { members: { userId: string; role: string }[] }).members).toEqual([
      { recordId: expect.any(String), userId: 'alice', role: 'member' },
      { recordId: expect.any(String), userId: 'host', role: 'host' },
    ])
  })
})

describe('group administration', () => {
  it('promotes a member to admin and the admin can remove members, but cannot transfer hosting', async () => {
    const store = createMockStore()
    const groupId = await createGroup(store, 'host')
    await call(store, 'alice', { operation: 'joinGroup', groupId })
    await call(store, 'bob', { operation: 'joinGroup', groupId })
    await expect(call(store, 'alice', { operation: 'promoteMember', groupId, userId: 'bob' }))
      .resolves.toMatchObject({ success: false })
    await expect(call(store, 'host', { operation: 'promoteMember', groupId, userId: 'alice' }))
      .resolves.toMatchObject({ success: true })
    await expect(call(store, 'alice', { operation: 'transferHost', groupId, userId: 'bob' }))
      .resolves.toMatchObject({ success: false })
    await expect(call(store, 'alice', { operation: 'removeMember', groupId, userId: 'bob' }))
      .resolves.toMatchObject({ success: true })
    expect(store.get('groupMembers')?.size).toBe(2)
  })

  it('transfers hosting: old host steps down, new host owns the group', async () => {
    const store = createMockStore()
    const groupId = await createGroup(store, 'host')
    await call(store, 'alice', { operation: 'joinGroup', groupId })
    await expect(call(store, 'host', { operation: 'transferHost', groupId, userId: 'alice' }))
      .resolves.toMatchObject({ success: true })
    const fetched = await call(store, 'alice', { operation: 'getGroup', groupId })
    if (!fetched.success) throw new Error('Expected getGroup to succeed')
    expect((fetched.data as { group: { hostId: string }; role: string }).group.hostId).toBe('alice')
    expect((fetched.data as { role: string }).role).toBe('host')
    const oldHost = await call(store, 'host', { operation: 'getGroup', groupId })
    if (!oldHost.success) throw new Error('Expected getGroup to succeed')
    expect((oldHost.data as { role: string }).role).toBe('member')
    // The old host can now leave.
    await expect(call(store, 'host', { operation: 'leaveGroup', groupId })).resolves.toMatchObject({ success: true })
  })

  it('closing a group blocks joins and new group sessions', async () => {
    const store = createMockStore()
    const groupId = await createGroup(store, 'host')
    await expect(call(store, 'host', { operation: 'closeGroup', groupId })).resolves.toMatchObject({ success: true })
    await expect(call(store, 'host', { operation: 'closeGroup', groupId })).resolves.toMatchObject({ success: true })
    await expect(call(store, 'alice', { operation: 'joinGroup', groupId }))
      .resolves.toMatchObject({ success: false, error: expect.stringMatching(/closed/) })
    await expect(call(store, 'host', { operation: 'createGroupSession', groupId, ...SESSION_FIELDS }))
      .resolves.toMatchObject({ success: false })
  })
})

describe('group sessions and member removal', () => {
  it('only members create group sessions; the session carries the group id', async () => {
    const store = createMockStore()
    const groupId = await createGroup(store, 'host')
    await expect(call(store, 'stranger', { operation: 'createGroupSession', groupId, ...SESSION_FIELDS }))
      .resolves.toMatchObject({ success: false })
    const created = await call(store, 'host', { operation: 'createGroupSession', groupId, ...SESSION_FIELDS })
    expect(created.success).toBe(true)
    if (!created.success) throw new Error('Expected createGroupSession to succeed')
    const sessionId = (created.data as { recordId: string }).recordId
    expect(store.get('sessions')?.get(sessionId)?.data).toMatchObject({ groupId, hostId: 'host', status: 'open' })
  })

  it('removing a member withdraws future RSVPs but leaves past sessions alone', async () => {
    const store = createMockStore()
    const groupId = await createGroup(store, 'host')
    await call(store, 'alice', { operation: 'joinGroup', groupId })
    // Future group session with Alice going; past group session with Alice going.
    const future = await call(store, 'host', { operation: 'createGroupSession', groupId, ...SESSION_FIELDS })
    if (!future.success) throw new Error('Expected createGroupSession to succeed')
    const futureId = (future.data as { recordId: string }).recordId
    const pastId = 'past-session'
    seedSession(store, pastId, {
      ...SESSION_FIELDS,
      startsAt: '2020-01-01T12:00:00.000Z',
      hostId: 'host',
      chatChannelId: '',
      status: 'open',
      groupId,
    })
    const rsvps = store.get('rsvps') ?? new Map()
    store.set('rsvps', rsvps)
    rsvps.set('rsvp-future', {
      recordId: 'rsvp-future',
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'alice',
      data: { sessionId: futureId, userId: 'alice', status: 'going' },
    })
    rsvps.set('rsvp-past', {
      recordId: 'rsvp-past',
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'alice',
      data: { sessionId: pastId, userId: 'alice', status: 'going' },
    })
    await expect(call(store, 'host', { operation: 'removeMember', groupId, userId: 'alice' }))
      .resolves.toMatchObject({ success: true })
    expect(store.get('rsvps')?.has('rsvp-future')).toBe(false)
    expect(store.get('rsvps')?.has('rsvp-past')).toBe(true)
    expect(store.get('groupMembers')?.size).toBe(1)
  })
})
