export const COURTBOARD_WIDTH = 1000
export const COURTBOARD_HEIGHT = 500
export const COURTBOARD_MARKER_SIZE = 48

export const COURTBOARD_MARKERS = {
  A1: { x: 250, y: 180 },
  A2: { x: 250, y: 320 },
  B1: { x: 750, y: 180 },
  B2: { x: 750, y: 320 },
} as const

export type CourtboardMarkerLabel = keyof typeof COURTBOARD_MARKERS

export function courtboardRoomId(appId: string, sessionId: string): string {
  return `rally:${appId}:session:${sessionId}`
}

export function courtboardSessionId(roomId: string, appId: string): string | null {
  const prefix = `rally:${appId}:session:`
  if (!appId || !roomId.startsWith(prefix)) return null

  const sessionId = roomId.slice(prefix.length)
  return /^[A-Za-z0-9_-]{1,200}$/.test(sessionId) ? sessionId : null
}
