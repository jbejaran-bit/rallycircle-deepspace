import type { CollectionSchema } from 'deepspace/schema'

// Social graph and discovery preferences.
//
// Trust model: every write goes through a server action in
// src/server/social-actions.ts, which derives both identities from the
// verified Bearer token. Direct client writes are closed for every role
// (create/update/delete false) so a forged body field can never create a
// follow, block, report, or preference for another user.
//
// Reads are deliberately asymmetric:
// - follows are visible to any signed-in member (a follow graph is public
//   social data; hiding it would make E03 lists unimplementable client-side),
// - blocks and reports are visible only to their owner (member read 'own'),
//   so nobody can enumerate who blocked or reported whom,
// - discovery preferences are the owner's own record (member read 'own').

export const followsSchema: CollectionSchema = {
  name: 'follows',
  columns: [
    { name: 'followerId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true, required: true },
    { name: 'followeeId', storage: 'text', interpretation: 'plain', immutable: true, required: true },
  ],
  uniqueOn: ['followerId', 'followeeId'],
  ownerField: 'followerId',
  permissions: {
    '*': { read: false, create: false, update: false, delete: false },
    member: { read: true, create: false, update: false, delete: false },
    admin: { read: true, create: false, update: false, delete: false },
  },
}

export const blocksSchema: CollectionSchema = {
  name: 'blocks',
  columns: [
    { name: 'blockerId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true, required: true },
    { name: 'blockedId', storage: 'text', interpretation: 'plain', immutable: true, required: true },
  ],
  uniqueOn: ['blockerId', 'blockedId'],
  ownerField: 'blockerId',
  permissions: {
    '*': { read: false, create: false, update: false, delete: false },
    member: { read: 'own', create: false, update: false, delete: false },
    admin: { read: true, create: false, update: false, delete: false },
  },
}

export const reportsSchema: CollectionSchema = {
  name: 'reports',
  columns: [
    { name: 'reporterId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true, required: true },
    {
      name: 'targetType',
      storage: 'text',
      interpretation: { kind: 'select', options: ['user', 'session', 'content'] },
      immutable: true,
      required: true,
    },
    { name: 'targetId', storage: 'text', interpretation: 'plain', immutable: true, required: true, maxLength: 200 },
    { name: 'reason', storage: 'text', interpretation: 'plain', required: true, maxLength: 500 },
    {
      name: 'status',
      storage: 'text',
      interpretation: { kind: 'select', options: ['open', 'reviewed', 'dismissed'] },
      default: 'open',
    },
  ],
  ownerField: 'reporterId',
  permissions: {
    '*': { read: false, create: false, update: false, delete: false },
    member: { read: 'own', create: false, update: false, delete: false },
    admin: { read: true, create: false, update: false, delete: false },
  },
}

// One record per user, owned by that user. Preferences are self-reported
// only and are never a verified rating. JSON-encoded array fields are stored
// as text because schema columns are number|text only; the server action
// validates the decoded shape on every write.
export const discoveryPreferencesSchema: CollectionSchema = {
  name: 'discoveryPreferences',
  columns: [
    { name: 'userId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true, required: true },
    { name: 'formats', storage: 'text', interpretation: 'plain', default: '[]' },
    {
      name: 'level',
      storage: 'text',
      interpretation: { kind: 'select', options: ['All levels', 'Beginner', 'Intermediate', 'Advanced'] },
      default: 'All levels',
    },
    { name: 'area', storage: 'text', interpretation: 'plain', default: '', maxLength: 100 },
    { name: 'radiusMiles', storage: 'number', interpretation: 'plain', default: 10 },
    { name: 'timeStart', storage: 'text', interpretation: 'plain', default: '' },
    { name: 'timeEnd', storage: 'text', interpretation: 'plain', default: '' },
    { name: 'days', storage: 'text', interpretation: 'plain', default: '[]' },
  ],
  uniqueOn: ['userId'],
  ownerField: 'userId',
  permissions: {
    '*': { read: false, create: false, update: false, delete: false },
    member: { read: 'own', create: false, update: false, delete: false },
    admin: { read: true, create: false, update: false, delete: false },
  },
}
