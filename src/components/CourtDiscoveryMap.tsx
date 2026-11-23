import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { LayerGroup, Map as LeafletMap, Marker as LeafletMarker } from 'leaflet'
import { List, Map as MapIcon } from 'lucide-react'
import { isValidLatLng, type LatLng } from '@/lib/geo'
import 'leaflet/dist/leaflet.css'
import './court-map.css'

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

export default function CourtDiscoveryMap<T extends CourtPoint>({ courts, location, label, selectedId, onSelect, compact = false }: {
  courts: readonly T[]
  location?: LatLng | null
  label: string
  selectedId?: string
  onSelect: (court: T) => void
  compact?: boolean
}) {
  const container = useRef<HTMLDivElement>(null)
  const markerElements = useRef<Map<string, HTMLElement>>(new globalThis.Map())
  const markers = useRef<Map<string, LeafletMarker>>(new globalThis.Map())
  const mapView = useRef<LeafletMap | null>(null)
  const markerLayer = useRef<LayerGroup | null>(null)
  const leaflet = useRef<typeof import('leaflet') | null>(null)
  const currentCourts = useRef(courts)
  const selectCourt = useRef(onSelect)
  const activeId = useRef(selectedId)
  const [mapStatus, setMapStatus] = useState<'loading' | 'ready' | 'unavailable' | 'tiles-unavailable'>('loading')
  const [ready, setReady] = useState(false)
  // Equivalent result arrays and inline callbacks must not recreate the map.
  const geometry = JSON.stringify(courts.map((court, index) => ({
    id: court.id, name: court.name, lat: court.lat, lng: court.lng, number: court.pinNumber ?? index + 1,
  })).filter(isValidLatLng))
  const centerLat = isValidLatLng(location) ? location.lat : undefined
  const centerLng = isValidLatLng(location) ? location.lng : undefined

  useEffect(() => {
    currentCourts.current = courts
    selectCourt.current = onSelect
  }, [courts, onSelect])

  useEffect(() => {
    activeId.current = selectedId
    for (const [id, element] of markerElements.current) {
      element.setAttribute('aria-pressed', String(id === selectedId))
      markers.current.get(id)?.setZIndexOffset(id === selectedId ? 1000 : 0)
    }
  }, [selectedId])

  useEffect(() => {
    let disposed = false
    let remove: (() => void) | undefined
    void import('leaflet').then(module => {
      if (disposed || !container.current) return
      leaflet.current = module
      const view = module.map(container.current, { scrollWheelZoom: false }).setView([20, 0], 2)
      mapView.current = view
      markerLayer.current = module.layerGroup().addTo(view)
      remove = () => view.remove()
      const layer = module.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      })
      layer.on('tileerror', () => {
        if (!disposed) setMapStatus('tiles-unavailable')
      })
      layer.addTo(view)
      setMapStatus('ready')
      setReady(true)
    }).catch(() => {
      if (!disposed) setMapStatus('unavailable')
    })
    return () => {
      disposed = true
      remove?.()
      mapView.current = null
      markerLayer.current = null
      markerElements.current.clear()
      markers.current.clear()
    }
  }, [])

  useEffect(() => {
    const view = mapView.current
    const layer = markerLayer.current
    const module = leaflet.current
    if (!ready || !view || !layer || !module) return
    layer.clearLayers()
    markerElements.current.clear()
    markers.current.clear()
    const points = JSON.parse(geometry) as { id: string; name: string; lat: number; lng: number; number: number }[]
    const bounds: [number, number][] = points.map(point => [point.lat, point.lng])
    if (centerLat !== undefined && centerLng !== undefined) {
      bounds.push([centerLat, centerLng])
      module.circleMarker([centerLat, centerLng], { radius: 7, color: '#ffffff', weight: 2, fillColor: '#3b82f6', fillOpacity: 0.9 })
        .addTo(layer).bindTooltip('Search area')
    }
    for (const court of points) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'rally-court-pin'
      button.textContent = String(court.number)
      button.setAttribute('aria-label', `Select ${court.name}`)
      button.setAttribute('aria-pressed', String(court.id === activeId.current))
      button.setAttribute('data-pin-number', String(court.number))
      button.setAttribute('data-court-id', court.id)
      button.addEventListener('click', event => {
        event.stopPropagation()
        const selected = currentCourts.current.find(point => point.id === court.id && isValidLatLng(point))
        if (selected) selectCourt.current(selected)
      })
      // Native buttons supply both Enter and Space activation. Keep those
      // keystrokes out of Leaflet's map keyboard controls without cancelling it.
      button.addEventListener('keydown', event => event.stopPropagation())
      const pin = module.marker([court.lat, court.lng], {
        title: court.name,
        keyboard: false,
        zIndexOffset: court.id === activeId.current ? 1000 : 0,
        icon: module.divIcon({ className: 'rally-court-marker', html: button, iconSize: [44, 44], iconAnchor: [22, 22] }),
      }).addTo(layer)
      markerElements.current.set(court.id, button)
      markers.current.set(court.id, pin)
    }
    if (bounds.length) view.fitBounds(module.latLngBounds(bounds), { padding: [32, 32], maxZoom: 14, animate: false })
    else view.setView([20, 0], 2, { animate: false })
  }, [ready, geometry, centerLat, centerLng])

  return (
    <div>
      <div ref={container} role="region" aria-label={label} aria-busy={mapStatus === 'loading'} className={`relative z-0 min-w-0 rounded-2xl bg-[#202c25] ${compact ? 'h-56' : 'h-72 sm:h-[360px] lg:h-[500px]'}`} />
      {mapStatus === 'loading' && <p role="status" className="mt-2 text-sm text-white/75">Loading the court map…</p>}
      {(mapStatus === 'unavailable' || mapStatus === 'tiles-unavailable') && (
        <p role="status" className="mt-2 text-sm text-white/75">The map could not load completely. Use the court list for details and directions.</p>
      )}
      {ready && JSON.parse(geometry).length === 0 && <p className="mt-2 text-sm text-white/75">No mapped courts to display. Choose a court from the results.</p>}
    </div>
  )
}
