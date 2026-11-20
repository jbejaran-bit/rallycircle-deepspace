export const COURTBOARD_WIDTH = 1000
export const COURTBOARD_HEIGHT = 500
export const COURTBOARD_MARKER_SIZE = 72

export const COURTBOARD_MARKER_LABELS = ['A1', 'A2', 'B1', 'B2'] as const
export type CourtboardMarkerLabel = (typeof COURTBOARD_MARKER_LABELS)[number]

export function isCourtboardMarkerLabel(value: unknown): value is CourtboardMarkerLabel {
  return typeof value === 'string' && COURTBOARD_MARKER_LABELS.some((label) => label === value)
}

export const COURTBOARD_MARKERS: Record<CourtboardMarkerLabel, { x: number; y: number }> = {
  A1: { x: 250, y: 180 },
  A2: { x: 250, y: 320 },
  B1: { x: 750, y: 180 },
  B2: { x: 750, y: 320 },
}

export function courtboardMarkerId(label: CourtboardMarkerLabel): string {
  return `rally-player:${label}`
}

export function courtboardMarkerLabelFromId(id: unknown): CourtboardMarkerLabel | null {
  if (typeof id !== 'string') return null
  return COURTBOARD_MARKER_LABELS.find((label) => courtboardMarkerId(label) === id) ?? null
}

export interface CourtboardPosition {
  x: number
  y: number
}

export function courtboardRoomId(appId: string, sessionId: string): string {
  return `rally:${appId}:session:${sessionId}`
}

export function courtboardSessionId(roomId: string, appId: string): string | null {
  const prefix = `rally:${appId}:session:`
  if (!appId || !roomId.startsWith(prefix)) return null

  const sessionId = roomId.slice(prefix.length)
  return /^[A-Za-z0-9_-]{1,200}$/.test(sessionId) ? sessionId : null
}

export function clampCourtboardPosition(position: CourtboardPosition): CourtboardPosition | null {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return null
  return {
    x: Math.round(Math.min(900, Math.max(100, position.x))),
    y: Math.round(Math.min(430, Math.max(70, position.y))),
  }
}
