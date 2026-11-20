/**
 * Groups / clubs — pure validation and role helpers.
 *
 * A group is a small club of players. Membership is the only thing that
 * decides who may see member-only group sessions and who may RSVP to them;
 * the server actions enforce it, because RecordRoom row permissions cannot
 * express "member of group X" (see docs/track-ij-contracts.md).
 *
 * Identity always comes from the verified auth token. A `userId` supplied in
 * action params is only ever a *target* (e.g. the member an admin removes),
 * never the identity of the caller.
 */

export type GroupVisibility = 'public' | 'private'
export type GroupStatus = 'open' | 'closed'
export type GroupRole = 'host' | 'admin' | 'member'

export interface RallyGroup {
  name: string
  description: string
  visibility: GroupVisibility
  hostId: string
  status: GroupStatus
}

export interface GroupMember {
  groupId: string
  userId: string
  role: GroupRole
}

export const GROUP_NAME_MAX_LENGTH = 72
export const GROUP_DESCRIPTION_MAX_LENGTH = 280
/** Hard cap on members per group; keeps every membership query bounded. */
export const GROUP_MAX_MEMBERS = 200
/** Default page size for group and member lists. */
export const GROUP_PAGE_SIZE = 20
export const GROUP_PAGE_SIZE_MAX = 50
/** Upper bound on rows any single list query reads. */
export const GROUP_QUERY_LIMIT = 100

/** Validate group creation input. Returns a user-facing error or null. */
export function validateGroup(input: { name?: unknown; description?: unknown; visibility?: unknown }): string | null {
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > GROUP_NAME_MAX_LENGTH) {
    return 'Use a group name between 1 and 72 characters.'
  }
  if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > GROUP_DESCRIPTION_MAX_LENGTH)) {
    return 'Keep the group description under 280 characters.'
  }
  if (input.visibility !== 'public' && input.visibility !== 'private') {
    return 'Choose whether the group is public or private.'
  }
  return null
}

/** Roles allowed to manage members (remove, promote, transfer host is host-only). */
export function canManageMembers(role: GroupRole | null): boolean {
  return role === 'host' || role === 'admin'
}

/** A member may create sessions for the group; outsiders may not. */
export function canCreateGroupSession(role: GroupRole | null, status: GroupStatus): boolean {
  return role !== null && status === 'open'
}

/** Only the host may transfer hosting or close the group. */
export function isGroupHost(role: GroupRole | null): boolean {
  return role === 'host'
}

/**
 * Parse a bounded page size from untrusted input.
 * Non-integers, zero and negatives fall back to the default; anything above
 * the max is clamped.
 */
export function parsePageSize(value: unknown, fallback = GROUP_PAGE_SIZE): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return fallback
  return Math.min(value, GROUP_PAGE_SIZE_MAX)
}

/**
 * Cursor for createdAt-descending pagination: the `createdAt` of the first
 * item not yet returned. The next page includes that item and everything
 * older. Rows sharing one timestamp may repeat across pages (timestamps
 * have millisecond resolution, so this needs two creations in the same
 * millisecond); the page contents are never wrong, only potentially
 * duplicated at the boundary.
 */
export interface PageCursor {
  beforeCreatedAt?: string
}

export function parsePageCursor(params: Record<string, unknown>): PageCursor {
  const beforeCreatedAt = typeof params.beforeCreatedAt === 'string' ? params.beforeCreatedAt : undefined
  return { beforeCreatedAt }
}
