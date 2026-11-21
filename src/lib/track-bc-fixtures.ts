/**
 * Test fixtures for Track B + C (Codex can copy these verbatim).
 *
 * Every fixture matches the wire shape in docs/track-bc-contracts.md.
 * `exampleProfile` is a complete public profile; `examplePrivateProfile`
 * is the same player with visibility 'private'; `exampleStats` /
 * `exampleHistory` are the `getPlayerStats` / `getMatchHistory` payloads
 * for a player with a small finalized history. Nothing here is a verified
 * rating — `selfReportedLevel` is self-reported by definition.
 */

import type { PlayerProfile, ProfileCompleteness } from './profile.js'
import type { MatchHistoryEntry, PlayerStatsSummary } from './match-stats.js'

export const exampleProfile: PlayerProfile = {
  userId: 'player-alice',
  displayName: 'Alice',
  bio: 'Weekend doubles player, loves clay.',
  formats: ['Doubles', 'Singles'],
  preferredArea: 'Pittsburgh, PA',
  selfReportedLevel: 'Intermediate',
  visibility: 'public',
}

export const examplePrivateProfile: PlayerProfile = {
  ...exampleProfile,
  visibility: 'private',
}

export const exampleProfileCompleteness: ProfileCompleteness = {
  percent: 100,
  missing: [],
  complete: true,
}

export const exampleSinglesStats: PlayerStatsSummary = {
  userId: 'player-alice',
  format: 'singles',
  wins: 3,
  losses: 2,
  matchesPlayed: 5,
  winRate: 0.6,
  provisional: false,
  visibility: 'public',
}

export const exampleDoublesStats: PlayerStatsSummary = {
  userId: 'player-alice',
  format: 'doubles',
  wins: 1,
  losses: 0,
  matchesPlayed: 1,
  winRate: 1,
  provisional: true,
  visibility: 'public',
}

export const exampleHistory: MatchHistoryEntry[] = [
  {
    sessionId: 'session-2',
    format: 'singles',
    won: true,
    sets: [[6, 4], [6, 3]],
    finalizedAt: '2026-11-18T18:00:00.000Z',
    resultRevision: 12,
    status: 'final',
  },
  {
    sessionId: 'session-1',
    format: 'singles',
    won: false,
    sets: [[4, 6], [6, 7]],
    finalizedAt: '2026-11-11T18:00:00.000Z',
    resultRevision: 9,
    status: 'final',
  },
]

export const examplePlayerStatsResponse = {
  userId: 'player-alice',
  public: true,
  profile: {
    displayName: exampleProfile.displayName,
    bio: exampleProfile.bio,
    formats: exampleProfile.formats,
    preferredArea: exampleProfile.preferredArea,
    selfReportedLevel: exampleProfile.selfReportedLevel,
    visibility: exampleProfile.visibility,
  },
  completeness: exampleProfileCompleteness,
  stats: { singles: exampleSinglesStats, doubles: exampleDoublesStats },
}

export const examplePrivateStatsResponse = {
  userId: 'player-alice',
  public: false,
}

export const exampleMatchHistoryResponse = {
  userId: 'player-alice',
  public: true,
  entries: exampleHistory,
}
