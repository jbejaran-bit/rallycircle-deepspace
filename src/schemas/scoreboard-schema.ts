import type { CollectionSchema } from 'deepspace/schema'

/**
 * One scoreboard record per session (`uniqueOn: ['sessionId']`).
 *
 * Direct client writes are closed for every role: scores only change
 * through the `rallyCommand` server action, which runs them through the
 * per-session `RallyCommandRoom` (host check, server-side validation,
 * optimistic-concurrency version check). Members can read every
 * scoreboard — participants must see the score live.
 *
 * `sets` and `matchTiebreak` use the SDK's JSON interpretation: objects
 * are stringified on write and parsed on read (verified in
 * `deepspace/dist/worker.js` `rowToData`/`coerceValue`). `version` starts
 * at 1; `updatedBy` is the verified user id stamped by the server action.
 * The record's own `updatedAt` is the authoritative last-write time.
 */
export const matchScoresSchema: CollectionSchema = {
  name: 'matchScores',
  columns: [
    { name: 'sessionId', storage: 'text', interpretation: 'plain', required: true, immutable: true, maxLength: 200 },
    { name: 'teamAName', storage: 'text', interpretation: 'plain', required: true, maxLength: 40 },
    { name: 'teamBName', storage: 'text', interpretation: 'plain', required: true, maxLength: 40 },
    { name: 'status', storage: 'text', interpretation: { kind: 'select', options: ['not_started', 'in_progress', 'final'] }, default: 'not_started' },
    { name: 'sets', storage: 'text', interpretation: { kind: 'json' }, default: [] },
    { name: 'matchTiebreak', storage: 'text', interpretation: { kind: 'json' }, default: null },
    { name: 'version', storage: 'number', interpretation: 'plain', default: 1 },
    { name: 'updatedBy', storage: 'text', interpretation: 'plain', default: '' },
  ],
  uniqueOn: ['sessionId'],
  permissions: {
    '*': { read: false, create: false, update: false, delete: false },
    member: { read: true, create: false, update: false, delete: false },
    admin: { read: true, create: false, update: false, delete: false },
  },
}
