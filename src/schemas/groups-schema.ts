import type { CollectionSchema } from 'deepspace/schema'

/**
 * Groups and group membership.
 *
 * Privacy model (read the contracts doc before changing this):
 * - `groups` uses `visibilityField: 'visibility'` with member read
 *   `'published'`: a row whose visibility is `'public'` is readable by any
 *   signed-in member; a `'private'` row is readable only by its owner
 *   (the host). Private-group members who are not the host read group
 *   details through the `groups` server action, never through direct
 *   record reads.
 * - `groupMembers` is member read `'own'` only: nobody can enumerate
 *   another group's roster through direct reads. Member lists are served
 *   by the `groups` action after a membership check.
 * - Direct client writes are closed on both collections for every role.
 *   All membership changes go through the `groups` server action, which
 *   runs with the verified auth identity.
 */
export const groupsSchema: CollectionSchema = {
  name: 'groups',
  columns: [
    { name: 'name', storage: 'text', interpretation: 'plain', required: true, maxLength: 72 },
    { name: 'description', storage: 'text', interpretation: 'plain', default: '', maxLength: 280 },
    {
      name: 'visibility',
      storage: 'text',
      interpretation: { kind: 'select', options: ['public', 'private'] },
      required: true,
    },
    // Not immutable: host transfer updates this column. Direct client
    // writes are closed for every role, so only the `groups` action can
    // change it, and only the current host may transfer.
    { name: 'hostId', storage: 'text', interpretation: 'plain', userBound: true },
    {
      name: 'status',
      storage: 'text',
      interpretation: { kind: 'select', options: ['open', 'closed'] },
      default: 'open',
    },
  ],
  ownerField: 'hostId',
  visibilityField: 'visibility',
  permissions: {
    '*': { read: false, create: false, update: false, delete: false },
    member: { read: 'published', create: false, update: false, delete: false },
    admin: { read: true, create: false, update: false, delete: false },
  },
}

export const groupMembersSchema: CollectionSchema = {
  name: 'groupMembers',
  columns: [
    { name: 'groupId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'userId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true },
    {
      name: 'role',
      storage: 'text',
      interpretation: { kind: 'select', options: ['host', 'admin', 'member'] },
      required: true,
    },
  ],
  uniqueOn: ['groupId', 'userId'],
  ownerField: 'userId',
  permissions: {
    '*': { read: false, create: false, update: false, delete: false },
    member: { read: 'own', create: false, update: false, delete: false },
    admin: { read: true, create: false, update: false, delete: false },
  },
}
