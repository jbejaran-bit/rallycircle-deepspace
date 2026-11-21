import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { List, Map as MapIcon } from 'lucide-react'
import type { LatLng } from '@/lib/geo'
import 'leaflet/dist/leaflet.css'

interface CourtPoint extends LatLng {
  id: string
  name: string
  pinNumber?: number
}

const wideScreen = '(min-width: 1024px)'

function subscribeToWidth(notify: () => void) {
  const media = window.matchMedia(wideScreen)
  media.addEventListener('change', notify)
  return () => media.removeEventListener('change', notify)
}

export function CourtMapLayout({ map, details, children }: { map: ReactNode; details: ReactNode; children: ReactNode }) {
  const wide = useSyncExternalStore(subscribeToWidth, () => window.matchMedia(wideScreen).matches, () => false)
  const [mobileView, setMobileView] = useState<'list' | 'map'>('list')
  const mapVisible = wide || mobileView === 'map'
  const listVisible = wide || mobileView === 'list'

  return (
    <div className="space-y-3">
      <div role="group" aria-label="Court results view" className="flex w-fit max-w-full gap-1 rounded-xl border border-white/15 p-1 lg:hidden">
        <button type="button" aria-pressed={mobileView === 'list'} onClick={() => setMobileView('list')} className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-semibold aria-pressed:bg-[#d7fc83] aria-pressed:text-[#17231b] focus-visible:outline-2">
          <List size={16} aria-hidden /> List
        </button>
        <button type="button" aria-pressed={mobileView === 'map'} onClick={() => setMobileView('map')} className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-semibold aria-pressed:bg-[#d7fc83] aria-pressed:text-[#17231b] focus-visible:outline-2">
          <MapIcon size={16} aria-hidden /> Map
        </button>
      </div>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        {mapVisible && <div className="min-w-0">{map}</div>}
        <div className="min-w-0 space-y-4">
          {details}
          <div hidden={!listVisible}>{children}</div>
        </div>
      </div>
    </div>
  )
}

export default function CourtDiscoveryMap<T extends CourtPoint>({ courts, location, label, selectedId, onSelect }: {
  courts: readonly T[]
  location?: LatLng | null
  label: string
  selectedId?: string
  onSelect: (court: T) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const markerElements = useRef<Map<string, HTMLElement>>(new globalThis.Map())
  const activeId = useRef(selectedId)
  const [mapStatus, setMapStatus] = useState<'loading' | 'ready' | 'unavailable' | 'tiles-unavailable'>('loading')

  useEffect(() => {
    activeId.current = selectedId
    for (const [id, element] of markerElements.current) {
      element.setAttribute('aria-pressed', String(id === selectedId))
    }
  }, [selectedId])

  useEffect(() => {
    let disposed = false
    let remove: (() => void) | undefined
    const elements = markerElements.current
    void import('leaflet').then(({ map, tileLayer, marker, divIcon, circleMarker, latLngBounds }) => {
      if (disposed || !container.current) return
      const view = map(container.current, { scrollWheelZoom: false })
      remove = () => view.remove()
      const points: [number, number][] = courts.map(court => [court.lat, court.lng])
      if (location) points.push([location.lat, location.lng])
      view.fitBounds(latLngBounds(points), { padding: [36, 36], maxZoom: 14 })
      const layer = tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      })
      layer.on('tileerror', () => {
        if (!disposed) setMapStatus('tiles-unavailable')
      })
      layer.addTo(view)

      if (location) {
        circleMarker([location.lat, location.lng], { radius: 8, color: '#ffffff', weight: 2, fillColor: '#3b82f6', fillOpacity: 0.9 })
          .addTo(view)
          .bindTooltip('Search location')
      }

      courts.forEach((court, index) => {
        const number = document.createElement('span')
        number.className = 'grid h-8 w-8 place-items-center rounded-full border-2 border-[#17231b] bg-[#d7fc83] font-bold text-[#17231b] group-aria-pressed:bg-white'
        number.textContent = String(court.pinNumber ?? index + 1)
        number.setAttribute('aria-hidden', 'true')
        const pin = marker([court.lat, court.lng], {
          title: court.name,
          icon: divIcon({ className: 'group', html: number, iconSize: [32, 32], iconAnchor: [16, 16] }),
        }).addTo(view).on('click', () => onSelect(court))
        const element = pin.getElement()
        if (element) {
          element.setAttribute('aria-label', `Select ${court.name}`)
          element.setAttribute('aria-pressed', String(court.id === activeId.current))
          elements.set(court.id, element)
        }
      })
      setMapStatus('ready')
    }).catch(() => {
      if (!disposed) setMapStatus('unavailable')
    })
    return () => {
      disposed = true
      remove?.()
      elements.clear()
    }
  }, [courts, location, onSelect])

  return (
    <div>
      <div ref={container} role="region" aria-label={label} aria-busy={mapStatus === 'loading'} className="relative z-0 h-72 min-w-0 rounded-2xl bg-[#202c25] sm:h-[360px] lg:h-[500px]" />
      {mapStatus === 'loading' && <p role="status" className="mt-2 text-sm text-white/75">Loading the court map…</p>}
      {(mapStatus === 'unavailable' || mapStatus === 'tiles-unavailable') && (
        <p role="status" className="mt-2 text-sm text-white/75">The map could not load completely. Use the court list for details and directions.</p>
      )}
    </div>
  )
}
