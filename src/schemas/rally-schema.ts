import type { CollectionSchema } from 'deepspace/schema'
import { SESSION_FORMATS } from '../lib/rally.js'

const sessionMemberWritableFields = [
  'format',
  'title',
  'court',
  'location',
  'startsAt',
  'durationMinutes',
  'targetPlayers',
  'capacity',
  'level',
  'notes',
  'chatChannelId',
]

// A session is a public invitation to signed-in members, not a commercial court booking.
export const sessionsSchema: CollectionSchema = {
  name: 'sessions',
  columns: [
    { name: 'matchScore', storage: 'text', interpretation: 'plain' },
    { name: 'pendingResult', storage: 'text', interpretation: 'plain', default: '' },
    { name: 'format', storage: 'text', interpretation: { kind: 'select', options: [...SESSION_FORMATS] } },
    { name: 'title', storage: 'text', interpretation: 'plain', required: true, maxLength: 72 },
    { name: 'court', storage: 'text', interpretation: 'plain', required: true, maxLength: 100 },
    { name: 'location', storage: 'text', interpretation: 'plain', required: true, maxLength: 100 },
    { name: 'startsAt', storage: 'text', interpretation: { kind: 'datetime' }, required: true },
    { name: 'durationMinutes', storage: 'number', interpretation: 'plain', required: true },
    { name: 'capacity', storage: 'number', interpretation: 'plain', immutable: true },
    { name: 'targetPlayers', storage: 'number', interpretation: 'plain', required: true },
    { name: 'level', storage: 'text', interpretation: { kind: 'select', options: ['All levels', 'Beginner', 'Intermediate', 'Advanced'] }, required: true },
    { name: 'notes', storage: 'text', interpretation: 'plain', default: '', maxLength: 400 },
    { name: 'hostId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true },
    { name: 'chatChannelId', storage: 'text', interpretation: 'plain', default: '' },
    { name: 'status', storage: 'text', interpretation: { kind: 'select', options: ['open', 'cancelled'] }, default: 'open' },
    { name: 'seriesId', storage: 'text', interpretation: 'plain', default: '' },
    { name: 'scheduleRevision', storage: 'number', interpretation: 'plain', default: 0 },
  ],
  ownerField: 'hostId',
  permissions: {
    '*': { read: false, create: false, update: false, delete: false },
    member: { read: true, create: true, update: 'own', delete: false, writableFields: sessionMemberWritableFields },
    admin: { read: true, create: true, update: true, delete: true, writableFields: sessionMemberWritableFields },
  },
}

// One RSVP per signed-in user per session is enforced by the Durable Object,
// not merely by hiding a button in the React UI.
export const rsvpsSchema: CollectionSchema = {
  name: 'rsvps',
  columns: [
    { name: 'sessionId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'userId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true },
    { name: 'status', storage: 'text', interpretation: { kind: 'select', options: ['going', 'maybe'] }, required: true },
  ],
  uniqueOn: ['sessionId', 'userId'],
  ownerField: 'userId',
  permissions: {
    '*': { read: false, create: false, update: false, delete: false },
    member: { read: true, create: false, update: false, delete: false },
    admin: { read: true, create: false, update: false, delete: false },
  },
}

export const waitlistsSchema: CollectionSchema = {
  name: 'waitlists',
  columns: [
    { name: 'sessionId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'userId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true },
  ],
  uniqueOn: ['sessionId', 'userId'],
  ownerField: 'userId',
  permissions: {
    '*': { read: false, create: false, update: false, delete: false },
    member: { read: 'own', create: false, update: false, delete: false },
    admin: { read: true, create: false, update: false, delete: false },
  },
}

// One scheduling poll per session, ever (uniqueOn sessionId). Options and
// the server-maintained tally are JSON text, the matchScore precedent.
// Direct client writes are closed for every role; the command room owns
// all mutations. Polls are member-readable (session-level information);
// individual votes are private (see pollVotesSchema).
export const pollsSchema: CollectionSchema = {
  name: 'polls',
  columns: [
    { name: 'sessionId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'hostId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true },
    { name: 'options', storage: 'text', interpretation: 'plain', required: true },
    { name: 'status', storage: 'text', interpretation: { kind: 'select', options: ['open', 'finalizing', 'finalized', 'cancelled'] }, default: 'open' },
    { name: 'finalizedOptionId', storage: 'text', interpretation: 'plain', default: '' },
    { name: 'tally', storage: 'text', interpretation: 'plain', default: '{}' },
  ],
  uniqueOn: ['sessionId'],
  ownerField: 'hostId',
  permissions: {
    '*': { read: false, create: false, update: false, delete: false },
    member: { read: true, create: false, update: false, delete: false },
    admin: { read: true, create: false, update: false, delete: false },
  },
}

// Approval-style votes: one record per (poll, option, user). The composite
// uniqueOn is the second line of defence behind the serialised command
// room; the room also checks before creating, so a duplicate is an
// idempotent success, never a second vote. Votes are owner-readable only.
export const pollVotesSchema: CollectionSchema = {
  name: 'pollVotes',
  columns: [
    { name: 'pollId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'optionId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'userId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true },
  ],
  uniqueOn: ['pollId', 'optionId', 'userId'],
  ownerField: 'userId',
  permissions: {
    '*': { read: false, create: false, update: false, delete: false },
    member: { read: 'own', create: false, update: false, delete: false },
    admin: { read: true, create: false, update: false, delete: false },
  },
}

// In-app notifications. `readAt` is text ('' = unread, ISO timestamp =
// read) because SDK storage is number|text and no existing column uses
// the boolean interpretation. `uniqueOn` enforces idempotent emission.
// Only the recipient may read; only server code may write.
export const notificationsSchema: CollectionSchema = {
  name: 'notifications',
  columns: [
    { name: 'recipientId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true, required: true },
    { name: 'type', storage: 'text', interpretation: { kind: 'select', options: ['waitlist_promoted', 'session_cancelled', 'schedule_changed', 'poll_created', 'poll_finalized', 'result_confirmed', 'result_disputed'] }, required: true },
    { name: 'sessionId', storage: 'text', interpretation: 'plain', default: '' },
    { name: 'title', storage: 'text', interpretation: 'plain', required: true, maxLength: 200 },
    { name: 'body', storage: 'text', interpretation: 'plain', required: true, maxLength: 500 },
    { name: 'link', storage: 'text', interpretation: 'plain', default: '', maxLength: 500 },
    { name: 'idempotencyKey', storage: 'text', interpretation: 'plain', required: true },
    { name: 'readAt', storage: 'text', interpretation: 'plain', default: '' },
  ],
  uniqueOn: ['recipientId', 'idempotencyKey'],
  ownerField: 'recipientId',
  permissions: {
    '*': { read: false, create: false, update: false, delete: false },
    member: { read: 'own', create: false, update: false, delete: false },
    admin: { read: true, create: false, update: false, delete: false },
  },
}

// One opt-out row per user. Absent = all categories on. Written only by
// the `notifications` action, which checks the caller owns the row.
export const notificationPreferencesSchema: CollectionSchema = {
  name: 'notificationPreferences',
  columns: [
    { name: 'userId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true, required: true },
    { name: 'preferences', storage: 'text', interpretation: 'plain', default: '{"results":true,"polls":true}' },
  ],
  uniqueOn: ['userId'],
  ownerField: 'userId',
  permissions: {
    '*': { read: false, create: false, update: false, delete: false },
    member: { read: 'own', create: false, update: false, delete: false },
    admin: { read: true, create: false, update: false, delete: false },
  },
}

// A bounded recurring practice series. The template is JSON text; the
// room materialises at most `count` (2–12) ordinary sessions from it.
export const recurringSeriesSchema: CollectionSchema = {
  name: 'recurringSeries',
  columns: [
    { name: 'hostId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true, required: true },
    { name: 'template', storage: 'text', interpretation: 'plain', required: true },
    { name: 'startStartsAt', storage: 'text', interpretation: { kind: 'datetime' }, required: true },
    { name: 'intervalWeeks', storage: 'number', interpretation: 'plain', required: true },
    { name: 'count', storage: 'number', interpretation: 'plain', required: true },
    { name: 'status', storage: 'text', interpretation: { kind: 'select', options: ['active', 'cancelled'] }, default: 'active' },
    { name: 'generatedCount', storage: 'number', interpretation: 'plain', default: 0 },
  ],
  ownerField: 'hostId',
  permissions: {
    '*': { read: false, create: false, update: false, delete: false },
    member: { read: true, create: false, update: false, delete: false },
    admin: { read: true, create: false, update: false, delete: false },
  },
}
