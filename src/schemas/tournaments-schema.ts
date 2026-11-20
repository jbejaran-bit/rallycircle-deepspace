import type { CollectionSchema } from 'deepspace/schema'

/**
 * Tournaments, tournament players, and tournament matches.
 *
 * Tournaments are public within the app (like sessions): any signed-in
 * member may read a tournament, its players, and its matches. The
 * competitive integrity does not come from hiding rows — it comes from
 * the server actions: only the host manages a tournament, and standings
 * are computed only from genuinely finalized results.
 *
 * - `tournamentPlayers.userId` is plain text, not `userBound`: the host
 *   registers players, so the row's user is not the caller. The host
 *   supplies the id and the action validates it.
 * - `tournamentMatches.playerIds` is a JSON array of 1–2 user ids stored
 *   as text (one player = a bye). `winnerId` is '' until the match is
 *   final. `sessionId` is '' until the host schedules the match.
 * - Direct client writes are closed on all three collections for every
 *   role. All changes go through the `tournaments` server action.
 * - `uniqueOn` on matches makes fixture generation idempotent: a retry
 *   of the same generation cannot create a duplicate match.
 */
export const tournamentsSchema: CollectionSchema = {
  name: 'tournaments',
  columns: [
    { name: 'name', storage: 'text', interpretation: 'plain', required: true, maxLength: 72 },
    {
      name: 'format',
      storage: 'text',
      interpretation: { kind: 'select', options: ['round-robin', 'single-elimination'] },
      required: true,
    },
    {
      name: 'status',
      storage: 'text',
      interpretation: { kind: 'select', options: ['created', 'in_progress', 'completed', 'cancelled'] },
      default: 'created',
    },
    { name: 'hostId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true },
    { name: 'maxPlayers', storage: 'number', interpretation: 'plain', required: true },
  ],
  ownerField: 'hostId',
  permissions: {
    '*': { read: false, create: false, update: false, delete: false },
    member: { read: true, create: false, update: false, delete: false },
    admin: { read: true, create: false, update: false, delete: false },
  },
}

export const tournamentPlayersSchema: CollectionSchema = {
  name: 'tournamentPlayers',
  columns: [
    { name: 'tournamentId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'userId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'seed', storage: 'number', interpretation: 'plain', required: true },
    {
      name: 'status',
      storage: 'text',
      interpretation: { kind: 'select', options: ['active', 'withdrawn'] },
      default: 'active',
    },
  ],
  uniqueOn: ['tournamentId', 'userId'],
  ownerField: 'userId',
  permissions: {
    '*': { read: false, create: false, update: false, delete: false },
    member: { read: true, create: false, update: false, delete: false },
    admin: { read: true, create: false, update: false, delete: false },
  },
}

export const tournamentMatchesSchema: CollectionSchema = {
  name: 'tournamentMatches',
  columns: [
    { name: 'tournamentId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'round', storage: 'number', interpretation: 'plain', required: true, immutable: true },
    { name: 'slot', storage: 'number', interpretation: 'plain', required: true, immutable: true },
    { name: 'playerIds', storage: 'text', interpretation: 'plain', required: true },
    { name: 'sessionId', storage: 'text', interpretation: 'plain', default: '' },
    {
      name: 'status',
      storage: 'text',
      interpretation: { kind: 'select', options: ['pending', 'scheduled', 'final', 'cancelled'] },
      default: 'pending',
    },
    { name: 'winnerId', storage: 'text', interpretation: 'plain', default: '' },
  ],
  uniqueOn: ['tournamentId', 'round', 'slot'],
  permissions: {
    '*': { read: false, create: false, update: false, delete: false },
    member: { read: true, create: false, update: false, delete: false },
    admin: { read: true, create: false, update: false, delete: false },
  },
}
