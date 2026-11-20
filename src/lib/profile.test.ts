import { describe, expect, it } from 'vitest'
import {
  isSameProfile,
  looksLikeCoordinates,
  profileCompleteness,
  validateProfileInput,
  type PlayerProfile,
  type ProfileInput,
} from './profile.js'

const valid: ProfileInput = {
  displayName: 'Alice',
  bio: 'Weekend doubles player.',
  formats: ['Doubles', 'Singles'],
  preferredArea: 'Pittsburgh, PA',
  selfReportedLevel: 'Intermediate',
  visibility: 'public',
}

function profile(overrides: Partial<PlayerProfile> = {}): PlayerProfile {
  return {
    userId: 'alice',
    displayName: 'Alice',
    bio: 'Weekend doubles player.',
    formats: ['Doubles'],
    preferredArea: 'Pittsburgh, PA',
    selfReportedLevel: 'Intermediate',
    visibility: 'public',
    ...overrides,
  }
}

describe('profile validation', () => {
  it('accepts a complete valid profile', () => {
    expect(validateProfileInput(valid)).toMatchObject({ ok: true })
  })

  it('rejects an empty or over-long display name', () => {
    expect(validateProfileInput({ ...valid, displayName: '' }).ok).toBe(false)
    expect(validateProfileInput({ ...valid, displayName: 'x'.repeat(41) }).ok).toBe(false)
    expect(validateProfileInput({ ...valid, displayName: '  Alice  ' })).toMatchObject({
      ok: true,
      data: { displayName: 'Alice' },
    })
  })

  it('rejects a bio over 280 characters', () => {
    expect(validateProfileInput({ ...valid, bio: 'x'.repeat(281) }).ok).toBe(false)
    expect(validateProfileInput({ ...valid, bio: 'x'.repeat(280) }).ok).toBe(true)
  })

  it('rejects coordinates and street-style values as a playing area', () => {
    expect(looksLikeCoordinates('40.44, -79.99')).toBe(true)
    expect(looksLikeCoordinates('Pittsburgh, PA')).toBe(false)
    expect(validateProfileInput({ ...valid, preferredArea: '40.4406, -79.9959' }).ok).toBe(false)
    expect(validateProfileInput({ ...valid, preferredArea: 'x'.repeat(101) }).ok).toBe(false)
  })

  it('rejects unknown formats, levels, and visibility values', () => {
    expect(validateProfileInput({ ...valid, formats: ['Squash'] }).ok).toBe(false)
    expect(validateProfileInput({ ...valid, selfReportedLevel: 'Pro' }).ok).toBe(false)
    expect(validateProfileInput({ ...valid, visibility: 'friends' }).ok).toBe(false)
    expect(validateProfileInput({ ...valid, selfReportedLevel: 'Unrated' }).ok).toBe(true)
  })

  it('rejects non-object input without throwing', () => {
    expect(validateProfileInput(null).ok).toBe(false)
    expect(validateProfileInput('alice').ok).toBe(false)
    expect(validateProfileInput([]).ok).toBe(false)
  })
})

describe('isSameProfile', () => {
  it('treats identical payloads as the same and any change as different', () => {
    const a = { ...valid, formats: [...valid.formats] }
    expect(isSameProfile(a, { ...valid, formats: [...valid.formats] })).toBe(true)
    expect(isSameProfile(a, { ...valid, bio: 'Changed.' })).toBe(false)
    expect(isSameProfile(a, { ...valid, formats: ['Singles'] })).toBe(false)
    expect(isSameProfile(a, { ...valid, visibility: 'private' })).toBe(false)
  })
})

describe('profileCompleteness', () => {
  it('reports 0% with no profile and 100% when complete', () => {
    expect(profileCompleteness(null)).toEqual({ percent: 0, missing: ['displayName', 'bio', 'formats', 'preferredArea', 'selfReportedLevel'], complete: false })
    expect(profileCompleteness(profile())).toEqual({ percent: 100, missing: [], complete: true })
  })

  it('lists exactly the missing fields', () => {
    const partial = profile({ bio: '', preferredArea: '', selfReportedLevel: 'Unrated' })
    expect(profileCompleteness(partial)).toEqual({
      percent: 40,
      missing: ['bio', 'preferredArea', 'selfReportedLevel'],
      complete: false,
    })
  })
})
