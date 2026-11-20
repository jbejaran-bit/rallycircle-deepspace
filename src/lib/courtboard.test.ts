import { describe, expect, it } from 'vitest'
import { courtboardRoomId, courtboardSessionId } from './courtboard'

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
})
