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
    // Set only by the `groups` server action when a member creates a group
    // session. Deliberately NOT in `sessionMemberWritableFields`: a client
    // must not be able to claim an arbitrary session belongs to a group.
    // The command room refuses RSVPs to a group session from non-members.
    { name: 'groupId', storage: 'text', interpretation: 'plain', default: '' },
    { name: 'status', storage: 'text', interpretation: { kind: 'select', options: ['open', 'cancelled'] }, default: 'open' },
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
