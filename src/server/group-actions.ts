/**
 * Groups server action — the only writer for `groups` and `groupMembers`.
 *
 * Trust model (see src/server/action-routes.ts): `tools.*` run RBAC-off,
 * so every operation below loads the group and the caller's membership and
 * checks them against the verified `userId` before writing. Direct client
 * writes are closed on both collections for every role.
 *
 * Member-removal semantics (I04): removing a member withdraws their RSVPs
 * and waitlist entries on *future open* group sessions (their spot is
 * freed; the next attendance command repairs waitlist promotion, the same
 * repair-on-next-command pattern the waitlist uses). Past results are
 * untouched — match history lives on sessions, not on membership. No
 * notification is emitted: the in-app notification system lives on a
 * separate branch and this action must not fabricate notification rows.
 */

import type { ActionHandler, ActionResult, ActionTools, GetActionData, MutateActionData, QueryActionData } from 'deepspace/worker'
import type { Env } from '../../worker.js'
import {
  GROUP_MAX_MEMBERS,
  GROUP_PAGE_SIZE,
  GROUP_QUERY_LIMIT,
  canCreateGroupSession,
  canManageMembers,
  isGroupHost,
  parsePageCursor,
  parsePageSize,
  validateGroup,
  type GroupMember,
  type GroupRole,
  type RallyGroup,
} from '../lib/groups.js'
import { validateSession, type RallySession } from '../lib/rally.js'

type Stored<T> = T & Record<string, unknown>

type GroupResult<T = { recordId: string }> = ActionResult<T>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function failure(error: string): GroupResult {
  return { success: false, error }
}

function success(recordId: string): GroupResult {
  return { success: true, data: { recordId } }
}

function paramString(params: Record<string, unknown>, key: string): string | null {
  const value = params[key]
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null
}

interface RecordRow<T> {
  recordId: string
  createdAt: string
  data: T
}

async function loadGroup(tools: ActionTools, groupId: string): Promise<RecordRow<RallyGroup> | null> {
  const result = await tools.get<Stored<RallyGroup>>('groups', groupId)
  if (!result.success) return null
  // The schema defaults `status` to 'open'; tolerate rows that predate the
  // column or a store that does not apply defaults.
  const data = { ...result.data.record.data, status: result.data.record.data.status ?? 'open' }
  return { recordId: groupId, createdAt: result.data.record.createdAt, data }
}

async function loadMembership(
  tools: ActionTools,
  groupId: string,
  userId: string,
): Promise<RecordRow<GroupMember> | null> {
  const result = await tools.query<Stored<GroupMember>>('groupMembers', {
    where: { groupId, userId },
    limit: 1,
  })
  if (!result.success) return null
  const record = result.data.records[0]
  return record ? { recordId: record.recordId, createdAt: record.createdAt, data: record.data } : null
}

async function countMembers(tools: ActionTools, groupId: string): Promise<number | null> {
  const result = await tools.query<Stored<GroupMember>>('groupMembers', {
    where: { groupId },
    limit: GROUP_MAX_MEMBERS,
  })
  if (!result.success) return null
  return result.data.records.length
}

/**
 * Withdraw a removed member's future attendance on group sessions.
 * Bounded: at most GROUP_QUERY_LIMIT group sessions are scanned, and each
 * RSVP/waitlist drain is capped at 100 rows per batch. Past sessions and
 * sessions whose results are already recorded are untouched.
 */
async function withdrawFutureAttendance(
  tools: ActionTools,
  groupId: string,
  userId: string,
  now: number,
): Promise<void> {
  const sessions = await tools.query<Stored<RallySession>>('sessions', {
    where: { groupId },
    limit: GROUP_QUERY_LIMIT,
  })
  if (!sessions.success) return
  for (const session of sessions.data.records) {
    if ((session.data.status ?? 'open') !== 'open') continue
    const startMs = Date.parse(session.data.startsAt)
    if (Number.isFinite(startMs) && startMs <= now) continue
    for (const collection of ['rsvps', 'waitlists'] as const) {
      let deleted = 100
      while (deleted >= 100) {
        const result = await tools.deleteWhere(collection, { sessionId: session.recordId, userId }, 100)
        if (!result.success) break
        deleted = result.data.deleted
      }
    }
  }
}

export const groupAction: ActionHandler<Env> = async ({ userId, params, tools }) => {
  if (!isRecord(params) || typeof params.operation !== 'string') {
    return failure('Invalid group request.')
  }
  const operation = params.operation
  const now = Date.now()

  if (operation === 'createGroup') {
    const error = validateGroup(params)
    if (error) return failure(error)
    const created = await tools.create('groups', {
      name: (params.name as string).trim(),
      description: typeof params.description === 'string' ? params.description : '',
      visibility: params.visibility,
    })
    if (!created.success) return failure('The group could not be created.')
    const groupId = created.data.recordId
    const member = await tools.create('groupMembers', { groupId, role: 'host' })
    if (!member.success) return failure('The group was created but your membership could not be recorded.')
    return success(groupId)
  }

  if (operation === 'listGroups') {
    const pageSize = parsePageSize(params.limit)
    const cursor = parsePageCursor(params)
    const [groupsResult, membershipsResult] = await Promise.all([
      tools.query<Stored<RallyGroup>>('groups', { orderBy: 'createdAt', orderDir: 'desc', limit: GROUP_QUERY_LIMIT }),
      tools.query<Stored<GroupMember>>('groupMembers', { where: { userId }, limit: GROUP_QUERY_LIMIT }),
    ])
    if (!groupsResult.success || !membershipsResult.success) {
      return failure('Groups could not be listed.')
    }
    const myRoles = new Map(membershipsResult.data.records.map(record => [record.data.groupId, record.data.role]))
    const visible = groupsResult.data.records.filter(record => {
      const role = myRoles.get(record.recordId)
      return record.data.visibility === 'public' || role !== undefined
    })
    const page: { recordId: string; data: RallyGroup; role: GroupRole | null }[] = []
    let nextBeforeCreatedAt: string | undefined
    for (const record of visible) {
      if (cursor.beforeCreatedAt !== undefined && record.createdAt > cursor.beforeCreatedAt) continue
      if (page.length >= pageSize) {
        nextBeforeCreatedAt = record.createdAt
        break
      }
      page.push({ recordId: record.recordId, data: record.data, role: myRoles.get(record.recordId) ?? null })
    }
    return {
      success: true,
      data: { groups: page, nextBeforeCreatedAt },
    } as GroupResult<{ groups: unknown[]; nextBeforeCreatedAt?: string }>
  }

  const groupId = paramString(params, 'groupId')
  if (!groupId) return failure('Invalid group request.')
  const group = await loadGroup(tools, groupId)
  if (!group) return failure('This group is unavailable.')
  const membership = await loadMembership(tools, groupId, userId)
  const role = membership?.data.role ?? null

  if (operation === 'getGroup') {
    if (group.data.visibility === 'private' && role === null) {
      return failure('This group is private.')
    }
    return {
      success: true,
      data: { recordId: groupId, group: group.data, role },
    } as GroupResult<{ recordId: string; group: RallyGroup; role: GroupRole | null }>
  }

  if (operation === 'joinGroup') {
    if (membership) return success(membership.recordId)
    if (group.data.status !== 'open') return failure('This group is closed.')
    const count = await countMembers(tools, groupId)
    if (count === null) return failure('Membership could not be checked.')
    if (count >= GROUP_MAX_MEMBERS) return failure('This group is full.')
    const created = await tools.create('groupMembers', { groupId, role: 'member' })
    if (!created.success) {
      // A concurrent join may have won the race; the uniqueOn constraint
      // rejects the duplicate, so re-reading makes the call idempotent.
      const retry = await loadMembership(tools, groupId, userId)
      return retry ? success(retry.recordId) : failure('You could not join this group.')
    }
    return success(created.data.recordId)
  }

  if (operation === 'leaveGroup') {
    if (!membership) return success(groupId)
    if (membership.data.role === 'host') {
      return failure('Transfer hosting before leaving the group.')
    }
    const removed = await tools.remove('groupMembers', membership.recordId)
    if (!removed.success) return failure('You could not leave this group.')
    await withdrawFutureAttendance(tools, groupId, userId, now)
    return success(groupId)
  }

  if (operation === 'listMembers') {
    if (role === null) return failure('Only members can see this group.')
    const pageSize = parsePageSize(params.limit)
    const cursor = parsePageCursor(params)
    const result = await tools.query<Stored<GroupMember>>('groupMembers', {
      where: { groupId },
      orderBy: 'createdAt',
      orderDir: 'desc',
      limit: GROUP_QUERY_LIMIT,
    })
    if (!result.success) return failure('Members could not be listed.')
    const page: { recordId: string; userId: string; role: GroupRole }[] = []
    let nextBeforeCreatedAt: string | undefined
    for (const record of result.data.records) {
      if (cursor.beforeCreatedAt !== undefined && record.createdAt > cursor.beforeCreatedAt) continue
      if (page.length >= pageSize) {
        nextBeforeCreatedAt = record.createdAt
        break
      }
      page.push({ recordId: record.recordId, userId: record.data.userId, role: record.data.role })
    }
    return {
      success: true,
      data: { members: page, nextBeforeCreatedAt },
    } as GroupResult<{ members: unknown[]; nextBeforeCreatedAt?: string }>
  }

  if (operation === 'createGroupSession') {
    if (!canCreateGroupSession(role, group.data.status)) {
      return failure('Only members of an open group can create a group session.')
    }
    // validateSession assumes string fields; reject mistyped input first
    // instead of letting it throw on `.trim()`.
    if (
      (params.format !== undefined && typeof params.format !== 'string') ||
      typeof params.title !== 'string' ||
      typeof params.court !== 'string' ||
      typeof params.location !== 'string' ||
      typeof params.startsAt !== 'string' ||
      typeof params.durationMinutes !== 'number' ||
      typeof params.targetPlayers !== 'number' ||
      typeof params.level !== 'string' ||
      (params.notes !== undefined && typeof params.notes !== 'string') ||
      (params.capacity !== undefined && typeof params.capacity !== 'number')
    ) {
      return failure('Invalid group session.')
    }
    const sessionInput = {
      format: params.format,
      title: params.title,
      court: params.court,
      location: params.location,
      startsAt: params.startsAt,
      durationMinutes: params.durationMinutes,
      targetPlayers: params.targetPlayers,
      capacity: params.capacity,
      level: params.level,
      notes: params.notes,
    }
    const error = validateSession(
      sessionInput as Omit<RallySession, 'hostId' | 'chatChannelId' | 'status'>,
      now,
    )
    if (error) return failure(error)
    const created = await tools.create('sessions', {
      ...sessionInput,
      title: (sessionInput.title as string).trim(),
      court: (sessionInput.court as string).trim(),
      location: (sessionInput.location as string).trim(),
      notes: typeof sessionInput.notes === 'string' ? sessionInput.notes : '',
      chatChannelId: '',
      status: 'open',
      groupId,
    })
    if (!created.success) return failure('The group session could not be created.')
    return success(created.data.recordId)
  }

  const targetUserId = paramString(params, 'userId')
  if (operation === 'removeMember' || operation === 'promoteMember' || operation === 'transferHost') {
    if (!targetUserId) return failure('Invalid group request.')
    if (operation === 'transferHost' && !isGroupHost(role)) {
      return failure('Only the group host can transfer hosting.')
    }
    if (operation !== 'transferHost' && !canManageMembers(role)) {
      return failure('Only the group host or an admin can manage members.')
    }
    if (targetUserId === userId && operation !== 'transferHost') {
      return failure('Use leave to remove yourself from the group.')
    }
    const target = await loadMembership(tools, groupId, targetUserId)
    if (!target) return failure('That user is not a member of this group.')

    if (operation === 'removeMember') {
      if (target.data.role === 'host') return failure('The group host cannot be removed.')
      const removed = await tools.remove('groupMembers', target.recordId)
      if (!removed.success) return failure('That member could not be removed.')
      await withdrawFutureAttendance(tools, groupId, targetUserId, now)
      return success(groupId)
    }

    if (operation === 'promoteMember') {
      if (!isGroupHost(role)) return failure('Only the group host can promote members.')
      if (target.data.role !== 'member') return failure('Only a member can be promoted to admin.')
      const updated = await tools.update('groupMembers', target.recordId, { role: 'admin' })
      return updated.success ? success(groupId) : failure('That member could not be promoted.')
    }

    // transferHost: target must be an ordinary member or admin; the old
    // host steps down to member and the group row's host changes with them.
    if (target.data.role === 'host') return failure('That user already hosts this group.')
    const [stepDown, stepUp, groupUpdate] = await Promise.all([
      tools.update('groupMembers', membership!.recordId, { role: 'member' }),
      tools.update('groupMembers', target.recordId, { role: 'host' }),
      tools.update('groups', groupId, { hostId: targetUserId }),
    ])
    if (!stepDown.success || !stepUp.success || !groupUpdate.success) {
      return failure('Hosting could not be transferred. Check the group and try again.')
    }
    return success(groupId)
  }

  if (operation === 'closeGroup') {
    if (!isGroupHost(role)) return failure('Only the group host can close it.')
    if (group.data.status === 'closed') return success(groupId)
    const updated = await tools.update('groups', groupId, { status: 'closed' })
    return updated.success ? success(groupId) : failure('The group could not be closed.')
  }

  return failure('Invalid group request.')
}
