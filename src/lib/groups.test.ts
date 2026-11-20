import { describe, expect, it } from 'vitest'
import {
  canCreateGroupSession,
  canManageMembers,
  isGroupHost,
  parsePageSize,
  validateGroup,
} from './groups.js'

describe('validateGroup', () => {
  it('accepts a public group with a description', () => {
    expect(validateGroup({ name: 'Saturday Club', description: 'Weekly games', visibility: 'public' })).toBeNull()
  })

  it('accepts a private group without a description', () => {
    expect(validateGroup({ name: 'Inner Circle', visibility: 'private' })).toBeNull()
  })

  it('rejects an empty name, an over-long name, and an over-long description', () => {
    expect(validateGroup({ name: '  ', visibility: 'public' })).toMatch(/name/)
    expect(validateGroup({ name: 'x'.repeat(73), visibility: 'public' })).toMatch(/name/)
    expect(validateGroup({ name: 'Club', description: 'x'.repeat(281), visibility: 'public' })).toMatch(/description/)
  })

  it('rejects an unknown visibility', () => {
    expect(validateGroup({ name: 'Club', visibility: 'secret' })).toMatch(/public or private/)
  })
})

describe('group roles', () => {
  it('only host and admin manage members; only the host transfers or closes', () => {
    expect(canManageMembers('host')).toBe(true)
    expect(canManageMembers('admin')).toBe(true)
    expect(canManageMembers('member')).toBe(false)
    expect(canManageMembers(null)).toBe(false)
    expect(isGroupHost('host')).toBe(true)
    expect(isGroupHost('admin')).toBe(false)
  })

  it('sessions can only be created for open groups by members', () => {
    expect(canCreateGroupSession('member', 'open')).toBe(true)
    expect(canCreateGroupSession('member', 'closed')).toBe(false)
    expect(canCreateGroupSession(null, 'open')).toBe(false)
  })
})

describe('parsePageSize', () => {
  it('clamps to the max and falls back on bad input', () => {
    expect(parsePageSize(10)).toBe(10)
    expect(parsePageSize(500)).toBe(50)
    expect(parsePageSize(0)).toBe(20)
    expect(parsePageSize('ten')).toBe(20)
    expect(parsePageSize(undefined)).toBe(20)
  })
})
