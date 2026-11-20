import { describe, expect, it } from 'vitest'
import {
  clampCourtboardPosition,
  courtboardMarkerId,
  courtboardMarkerLabelFromId,
  courtboardRoomId,
  courtboardSessionId,
} from './courtboard'

describe('courtboard room IDs', () => {
  it('scopes a session room to the app and recovers its session ID', () => {
    const roomId = courtboardRoomId('rally-test-app', 'session_123')

    expect(roomId).toBe('rally:rally-test-app:session:session_123')
    expect(courtboardSessionId(roomId, 'rally-test-app')).toBe('session_123')
  })

  it('rejects another app, a missing session, and malformed IDs', () => {
    expect(courtboardSessionId('rally:other-app:session:session_123', 'rally-test-app')).toBeNull()
    expect(courtboardSessionId('rally:rally-test-app:session:', 'rally-test-app')).toBeNull()
    expect(courtboardSessionId('rally:rally-test-app:session:../other', 'rally-test-app')).toBeNull()
    expect(courtboardSessionId('rally:rally-test-app:session:session_123', '')).toBeNull()
  })

  it('keeps moved markers inside the court and rejects non-finite positions', () => {
    expect(clampCourtboardPosition({ x: -50, y: 800 })).toEqual({ x: 100, y: 430 })
    expect(clampCourtboardPosition({ x: 399.7, y: 220.2 })).toEqual({ x: 400, y: 220 })
    expect(clampCourtboardPosition({ x: Number.NaN, y: 200 })).toBeNull()
  })

  it('uses a stable, label-specific shape ID for concurrent marker creation', () => {
    expect(courtboardMarkerId('A1')).toBe('rally-player:A1')
    expect(courtboardMarkerLabelFromId('rally-player:B2')).toBe('B2')
    expect(courtboardMarkerLabelFromId('unrelated-shape')).toBeNull()
  })
})
