/**
 * One-shot browser geolocation.
 *
 * - Opt-in: only called from a user tap, never on page load.
 * - One-shot: `getCurrentPosition`, never `watchPosition`. No continuous
 *   tracking, no background location.
 * - Never persisted: the coordinates live in React state for the current
 *   page only. They are sent to RallyCircle's own worker (for the
 *   server-side court search) and nowhere else; they are never written to
 *   a DeepSpace record, a cookie, or localStorage.
 */

import type { LatLng } from './geo'

export class GeolocationUnavailableError extends Error {
  constructor(message = 'Location is unavailable in this browser.') {
    super(message)
    this.name = 'GeolocationUnavailableError'
  }
}

export class GeolocationDeniedError extends Error {
  constructor(message = 'Location permission was denied. You can search by place name instead.') {
    super(message)
    this.name = 'GeolocationDeniedError'
  }
}

export function requestOneShotLocation(timeoutMs = 8000): Promise<LatLng> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new GeolocationUnavailableError())
      return
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ lat: coords.latitude, lng: coords.longitude }),
      (error) => {
        if (error.code === error.PERMISSION_DENIED) reject(new GeolocationDeniedError())
        else reject(new Error('Could not get your location. You can search by place name instead.'))
      },
      { timeout: timeoutMs, maximumAge: 60000 },
    )
  })
}
