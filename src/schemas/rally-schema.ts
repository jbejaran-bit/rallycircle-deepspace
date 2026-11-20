import type { CollectionSchema } from 'deepspace/schema'

const sessionMemberWritableFields = [
  'title',
  'court',
  'location',
  'startsAt',
  'durationMinutes',
  'targetPlayers',
  'level',
  'notes',
  'chatChannelId',
]

// A session is a public invitation to signed-in members, not a commercial court booking.
export const sessionsSchema: CollectionSchema = {
  name: 'sessions',
  columns: [
    { name: 'title', storage: 'text', interpretation: 'plain', required: true },
    { name: 'court', storage: 'text', interpretation: 'plain', required: true },
    { name: 'location', storage: 'text', interpretation: 'plain', required: true },
    { name: 'startsAt', storage: 'text', interpretation: { kind: 'datetime' }, required: true },
    { name: 'durationMinutes', storage: 'number', interpretation: 'plain', required: true },
    { name: 'targetPlayers', storage: 'number', interpretation: 'plain', required: true },
    { name: 'level', storage: 'text', interpretation: { kind: 'select', options: ['All levels', 'Beginner', 'Intermediate', 'Advanced'] }, required: true },
    { name: 'notes', storage: 'text', interpretation: 'plain', default: '' },
    { name: 'hostId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true },
    { name: 'chatChannelId', storage: 'text', interpretation: 'plain', default: '' },
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
    member: { read: true, create: false, update: false, delete: 'own' },
    admin: { read: true, create: false, update: false, delete: true },
  },
}
