/**
 * Track B + C collections: player profiles, player statistics, finalized
 * match results, and result audit history.
 *
 * Additive only. No existing collection is changed. All four collections are
 * written by server actions / the RallyCommandRoom only — direct client
 * create/update/delete is closed for every role, exactly like `rsvps` and
 * `waitlists`. Reads use the SDK's own permission model:
 *
 * - `profiles`, `playerStats`, `matchResults`: member `read: 'published'`
 *   with `visibilityField: { field: 'visibility', value: 'public' }`
 *   (verified in deepspace@0.44.2, worker.js: `published` = owner OR a row
 *   whose visibility field equals 'public'). A private row is readable
 *   only by its owner. Signed-out users (`*`) read nothing.
 * - `resultAudits`: member `read: true`, because audit rows describe
 *   sessions that are already member-readable; the detail payload contains
 *   only sets/winner/revision, never private data.
 *
 * `formats` on profiles uses the `json` column interpretation (a JS array),
 * the same pattern the scoreboard uses for set scores. `won` on
 * matchResults is a plain number (0/1) rather than a boolean column, so no
 * unverified boolean wire format is relied on.
 */

import type { CollectionSchema } from 'deepspace/schema'
import { PROFILE_LEVELS, PROFILE_VISIBILITY } from '../lib/profile.js'

/**
 * One public profile per player. Private account data (email, etc.) stays
 * in the `users` collection (read: 'own') and is never copied here.
 */
export const profilesSchema: CollectionSchema = {
  name: 'profiles',
  columns: [
    { name: 'userId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true, required: true },
    { name: 'displayName', storage: 'text', interpretation: 'plain', required: true, maxLength: 40 },
    { name: 'bio', storage: 'text', interpretation: 'plain', default: '', maxLength: 280 },
    { name: 'formats', storage: 'text', interpretation: { kind: 'json' }, default: '[]' },
    { name: 'preferredArea', storage: 'text', interpretation: 'plain', default: '', maxLength: 100 },
    { name: 'selfReportedLevel', storage: 'text', interpretation: { kind: 'select', options: [...PROFILE_LEVELS] }, default: 'Unrated' },
    { name: 'visibility', storage: 'text', interpretation: { kind: 'select', options: [...PROFILE_VISIBILITY] }, default: 'public' },
  ],
  uniqueOn: ['userId'],
  ownerField: 'userId',
  visibilityField: { field: 'visibility', value: 'public' },
  permissions: {
    '*': { read: false, create: false, update: false, delete: false },
    member: { read: 'published', create: false, update: false, delete: false },
    admin: { read: true, create: false, update: false, delete: false },
  },
}

/**
 * Incrementally maintained per-player, per-format statistics. Updated only
 * by the RallyCommandRoom when a result finalizes (or is corrected), never
 * by direct client writes. `visibility` mirrors the player's profile
 * visibility at write time, so private players never appear in public
 * statistics listings even at the record layer.
 */
export const playerStatsSchema: CollectionSchema = {
  name: 'playerStats',
  columns: [
    { name: 'userId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true, required: true },
    { name: 'format', storage: 'text', interpretation: { kind: 'select', options: ['singles', 'doubles'] }, required: true, immutable: true },
    { name: 'wins', storage: 'number', interpretation: 'plain', default: 0 },
    { name: 'losses', storage: 'number', interpretation: 'plain', default: 0 },
    { name: 'matchesPlayed', storage: 'number', interpretation: 'plain', default: 0 },
    { name: 'visibility', storage: 'text', interpretation: { kind: 'select', options: [...PROFILE_VISIBILITY] }, default: 'public' },
  ],
  uniqueOn: ['userId', 'format'],
  ownerField: 'userId',
  visibilityField: { field: 'visibility', value: 'public' },
  permissions: {
    '*': { read: false, create: false, update: false, delete: false },
    member: { read: false, create: false, update: false, delete: false },
    admin: { read: false, create: false, update: false, delete: false },
  },
}

/**
 * One row per player per finalized result. This is the queryable match
 * history (C08): `records.query` can filter by `userId` directly, so no
 * full-table scan is needed to build one player's history. Practice
 * matches are never written here (they are not competitive results).
 * On correction the row is updated in place to the new outcome and
 * `resultRevision` advances; the superseded outcome survives only in
 * `resultAudits`.
 */
export const matchResultsSchema: CollectionSchema = {
  name: 'matchResults',
  columns: [
    { name: 'sessionId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'userId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true, required: true },
    { name: 'format', storage: 'text', interpretation: { kind: 'select', options: ['singles', 'doubles'] }, required: true, immutable: true },
    { name: 'won', storage: 'number', interpretation: 'plain', required: true },
    { name: 'sets', storage: 'text', interpretation: { kind: 'json' }, required: true },
    { name: 'resultRevision', storage: 'number', interpretation: 'plain', required: true },
    { name: 'finalizedAt', storage: 'text', interpretation: { kind: 'datetime' }, required: true },
    { name: 'visibility', storage: 'text', interpretation: { kind: 'select', options: [...PROFILE_VISIBILITY] }, default: 'public' },
    /**
     * Outcome lifecycle, maintained by the serialized RallyCommandRoom at
     * write time (see result-finalization.ts): 'final' counts in statistics,
     * 'pending' is a host correction awaiting fresh approval (visible in
     * history, never counted), 'disputed' is hidden from both, 'cancelled'
     * is a session cancelled after finalization (hidden from both; the room
     * flips rows to it at cancel time, migration F4 write-side form). The read path
     * trusts this instead of fetching each session, so getPlayerStats issues
     * zero session GETs no matter how many results a player has. Additive:
     * rows written before this column count as 'final' (they were written
     * only on finalization); the read path treats a missing status that way.
     */
    { name: 'status', storage: 'text', interpretation: { kind: 'select', options: ['final', 'pending', 'disputed', 'cancelled'] }, default: 'final' },
  ],
  uniqueOn: ['sessionId', 'userId'],
  ownerField: 'userId',
  visibilityField: { field: 'visibility', value: 'public' },
  permissions: {
    '*': { read: false, create: false, update: false, delete: false },
    member: { read: false, create: false, update: false, delete: false },
    admin: { read: false, create: false, update: false, delete: false },
  },
}

/**
 * Minimal audit trail for meaningful result transitions. One row per
 * event; `detail` is a JSON string (sets, winner, revision) capped at
 * 1000 characters. Written only by the RallyCommandRoom.
 */
export const resultAuditsSchema: CollectionSchema = {
  name: 'resultAudits',
  columns: [
    { name: 'sessionId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'userId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true, required: true },
    { name: 'kind', storage: 'text', interpretation: { kind: 'select', options: ['finalized', 'disputed', 'corrected'] }, required: true, immutable: true },
    { name: 'detail', storage: 'text', interpretation: 'plain', default: '', maxLength: 1000 },
    { name: 'resultRevision', storage: 'number', interpretation: 'plain', required: true },
  ],
  ownerField: 'userId',
  permissions: {
    '*': { read: false, create: false, update: false, delete: false },
    member: { read: false, create: false, update: false, delete: false },
    admin: { read: false, create: false, update: false, delete: false },
  },
}

export const trackBcSchemas: CollectionSchema[] = [
  profilesSchema,
  playerStatsSchema,
  matchResultsSchema,
  resultAuditsSchema,
]
