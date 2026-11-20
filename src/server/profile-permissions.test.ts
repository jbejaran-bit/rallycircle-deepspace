/**
 * Schema permission tests — SDK helpers against the Track B + C schemas.
 *
 * Proves the authorization model at the record layer, independent of the
 * action handlers: direct client writes are closed for every role, and
 * reads honour the `visibilityField` + `read: 'published'` rule (owner OR
 * public rows) for profiles, stats, and results.
 */

import { describe, expect, it } from 'vitest'
import { canCreate, canDelete, canRead, canUpdate } from 'deepspace/worker'
import {
  matchResultsSchema,
  playerStatsSchema,
  profilesSchema,
  resultAuditsSchema,
} from '../schemas/profiles-schema.js'

function record(data: Record<string, unknown>, createdBy: string) {
  return { data, createdBy, recordId: 'row-1' }
}

describe('profile / stats / results record permissions', () => {
  it('closes direct client writes for every role on all four collections', () => {
    for (const schema of [profilesSchema, playerStatsSchema, matchResultsSchema, resultAuditsSchema]) {
      for (const role of ['viewer', 'member', 'admin', 'anonymous']) {
        expect(canCreate(schema, role)).toBe(false)
        expect(canUpdate(schema, role, record({}, 'alice'), 'alice')).toBe(false)
        expect(canDelete(schema, role, record({}, 'alice'), 'alice')).toBe(false)
      }
    }
  })

  it('lets members read public profiles and stats but not another member’s private rows', () => {
    const publicProfile = record({ userId: 'alice', visibility: 'public' }, 'alice')
    const privateProfile = record({ userId: 'alice', visibility: 'private' }, 'alice')
    expect(canRead(profilesSchema, 'member', publicProfile, 'bob')).toBe(true)
    expect(canRead(profilesSchema, 'member', privateProfile, 'bob')).toBe(false)
    expect(canRead(profilesSchema, 'member', privateProfile, 'alice')).toBe(true)
    expect(canRead(profilesSchema, 'viewer', publicProfile, null as unknown as string)).toBe(false)
    // 'published' is owner OR public-row: visibility alone grants the read,
    // so a null userId with the member role still sees a public row. In
    // practice the member role always carries an authenticated id; the
    // signed-out path is closed by the '*' role (read: false) above.

    const publicStats = record({ userId: 'alice', visibility: 'public' }, 'alice')
    const privateStats = record({ userId: 'alice', visibility: 'private' }, 'alice')
    expect(canRead(playerStatsSchema, 'member', publicStats, 'bob')).toBe(true)
    expect(canRead(playerStatsSchema, 'member', privateStats, 'bob')).toBe(false)
    expect(canRead(playerStatsSchema, 'member', privateStats, 'alice')).toBe(true)

    const privateResult = record({ userId: 'alice', visibility: 'private' }, 'alice')
    expect(canRead(matchResultsSchema, 'member', privateResult, 'bob')).toBe(false)
    expect(canRead(matchResultsSchema, 'member', privateResult, 'alice')).toBe(true)
  })

  it('lets members read audit rows for sessions they can already read', () => {
    const audit = record({ sessionId: 's1', kind: 'finalized' }, 'alice')
    expect(canRead(resultAuditsSchema, 'member', audit, 'bob')).toBe(true)
    expect(canRead(resultAuditsSchema, 'viewer', audit, null as unknown as string)).toBe(false)
  })
})
