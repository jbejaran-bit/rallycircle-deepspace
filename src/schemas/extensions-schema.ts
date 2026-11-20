import type { CollectionSchema } from 'deepspace/schema'
import { SESSION_FORMATS } from '../lib/rally.js'

// Track L — safe extensions. Every collection here is server-actions-only:
// direct client reads, creates, updates and deletes are closed for every
// role (including admin for writes — admins read own rows only through the
// same actions). The actions in src/server/extensions-actions.ts are the
// only read/write path, so they can enforce ownership and participant
// checks that record permissions alone cannot express.

const closedPermissions: CollectionSchema['permissions'] = {
  '*': { read: false, create: false, update: false, delete: false },
  member: { read: false, create: false, update: false, delete: false },
  admin: { read: false, create: false, update: false, delete: false },
}

/** L02 — a host's reusable session template (format, place, duration, time of day). */
export const sessionTemplatesSchema: CollectionSchema = {
  name: 'sessionTemplates',
  columns: [
    { name: 'userId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true },
    { name: 'format', storage: 'text', interpretation: { kind: 'select', options: [...SESSION_FORMATS] }, required: true },
    { name: 'court', storage: 'text', interpretation: 'plain', required: true, maxLength: 100 },
    { name: 'location', storage: 'text', interpretation: 'plain', required: true, maxLength: 100 },
    { name: 'durationMinutes', storage: 'number', interpretation: 'plain', required: true },
    { name: 'targetPlayers', storage: 'number', interpretation: 'plain', required: true },
    { name: 'capacity', storage: 'number', interpretation: 'plain' },
    { name: 'level', storage: 'text', interpretation: { kind: 'select', options: ['All levels', 'Beginner', 'Intermediate', 'Advanced'] }, required: true },
    { name: 'notes', storage: 'text', interpretation: 'plain', default: '', maxLength: 400 },
    // HH:MM in the host's local day, or '' for no preferred time.
    { name: 'timeOfDay', storage: 'text', interpretation: 'plain', default: '', maxLength: 5 },
  ],
  ownerField: 'userId',
  permissions: closedPermissions,
}

/**
 * L03 — a user's saved public courts. Only courts from court-discovery
 * results (OSM `osm:<type>/<id>`) are accepted; no private coordinates are
 * ever stored here. Rows are the saver's own records.
 */
export const favoriteCourtsSchema: CollectionSchema = {
  name: 'favoriteCourts',
  columns: [
    { name: 'userId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true },
    { name: 'placeId', storage: 'text', interpretation: 'plain', required: true, immutable: true, maxLength: 200 },
    { name: 'name', storage: 'text', interpretation: 'plain', required: true, maxLength: 200 },
    { name: 'lat', storage: 'number', interpretation: 'plain', required: true },
    { name: 'lng', storage: 'number', interpretation: 'plain', required: true },
    { name: 'locality', storage: 'text', interpretation: 'plain', default: '', maxLength: 200 },
  ],
  uniqueOn: ['userId', 'placeId'],
  ownerField: 'userId',
  permissions: closedPermissions,
}

/**
 * L04 — recurring weekly availability windows. A ranking signal only:
 * never treated as verified attendance, and never shown to other users
 * except as an aggregate matchmaking hint (see Track E+F contracts).
 */
export const availabilityWindowsSchema: CollectionSchema = {
  name: 'availabilityWindows',
  columns: [
    { name: 'userId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true },
    { name: 'dayOfWeek', storage: 'number', interpretation: 'plain', required: true },
    { name: 'startMinutes', storage: 'number', interpretation: 'plain', required: true },
    { name: 'endMinutes', storage: 'number', interpretation: 'plain', required: true },
  ],
  uniqueOn: ['userId', 'dayOfWeek', 'startMinutes'],
  ownerField: 'userId',
  permissions: closedPermissions,
}

/** L08 — host-only short notes on a finalized match, visible to participants only. */
export const matchNotesSchema: CollectionSchema = {
  name: 'matchNotes',
  columns: [
    { name: 'sessionId', storage: 'text', interpretation: 'plain', required: true, immutable: true, maxLength: 200 },
    { name: 'authorId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true },
    { name: 'note', storage: 'text', interpretation: 'plain', required: true, maxLength: 280 },
  ],
  ownerField: 'authorId',
  permissions: closedPermissions,
}

/**
 * L09 — chat moderation overlay. The SDK owns the chat messages
 * themselves; this collection records host decisions (pin / remove) per
 * message id, which the client applies when rendering. It never deletes
 * SDK rows. A `removed` row hides the message; a `pinned` row surfaces it.
 * Clearing a row un-does the decision.
 */
export const chatModerationSchema: CollectionSchema = {
  name: 'chatModeration',
  columns: [
    { name: 'channelId', storage: 'text', interpretation: 'plain', required: true, immutable: true, maxLength: 200 },
    { name: 'messageId', storage: 'text', interpretation: 'plain', required: true, immutable: true, maxLength: 200 },
    { name: 'action', storage: 'text', interpretation: { kind: 'select', options: ['pinned', 'removed'] }, required: true, immutable: true },
    { name: 'actorId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true },
  ],
  uniqueOn: ['channelId', 'messageId', 'action'],
  ownerField: 'actorId',
  permissions: closedPermissions,
}
