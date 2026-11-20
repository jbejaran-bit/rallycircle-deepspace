import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight, LocateFixed, MapPin, Navigation, Search } from 'lucide-react'
import { courts, distanceMiles, type Court } from '@/lib/courts'
import { fetchNearbyCourts, searchPlaces } from '@/lib/court-discovery-client'
import { clampRadiusKm, formatDistanceMiles, haversineMiles, RADIUS_OPTIONS_KM, type LatLng } from '@/lib/geo'
import { requestOneShotLocation } from '@/lib/location'
import type { DiscoveredCourt, GeocodedPlace } from '@/lib/osm'
import 'leaflet/dist/leaflet.css'

type Point = { lat: number; lng: number }

const DISCOVERED_STORAGE_KEY = 'rallycircle:discovered-courts'

/** Remember discovered courts for this tab only, so Find Games can offer distances for them. Ephemeral, never a record. */
function stashDiscoveredCourts(found: DiscoveredCourt[]): void {
  try {
    sessionStorage.setItem(DISCOVERED_STORAGE_KEY, JSON.stringify(found))
  } catch {
    // Private mode / quota: distance matching in Find Games simply falls back to Pittsburgh courts.
  }
}

function CourtMap({ onSelect }: { onSelect: (court: Court) => void }) {
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let disposed = false
    let remove: (() => void) | undefined
    void import('leaflet').then(({ map, tileLayer, marker, divIcon, latLngBounds }) => {
      if (disposed || !container.current) return
      const view = map(container.current, { scrollWheelZoom: false })
      remove = () => view.remove()
      view.fitBounds(latLngBounds(courts.map(court => [court.lat, court.lng])), { padding: [36, 36], maxZoom: 14 })
      tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      }).addTo(view)

      courts.forEach((court, index) => {
        marker([court.lat, court.lng], {
          title: court.name,
          icon: divIcon({
            className: '',
            html: `<span class="grid h-8 w-8 place-items-center rounded-full border-2 border-[#17231b] bg-[#d7fc83] font-bold text-[#17231b]">${index + 1}</span>`,
            iconSize: [32, 32],
            iconAnchor: [16, 16],
          }),
        }).addTo(view).on('click', () => onSelect(court))
      })
    }).catch(error => console.warn('Court map unavailable', error))
    return () => { disposed = true; remove?.() }
  }, [onSelect])

  return <div ref={container} role="region" aria-label="Pittsburgh tennis court map" className="relative z-0 h-[360px] min-w-0 rounded-2xl bg-[#202c25] lg:h-[500px]" />
}

/** Map for discovered courts. Remounts (via `mapKey`) when results change — simpler and safer than Leaflet layer bookkeeping. */
function DiscoveryMap({ courts: found, location, onSelect }: {
  courts: DiscoveredCourt[]
  location: LatLng | null
  onSelect: (court: DiscoveredCourt) => void
}) {
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let disposed = false
    let remove: (() => void) | undefined
    void import('leaflet').then(({ map, tileLayer, marker, divIcon, circleMarker, latLngBounds }) => {
      if (disposed || !container.current) return
      const view = map(container.current, { scrollWheelZoom: false })
      remove = () => view.remove()
      tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      }).addTo(view)

      const points: [number, number][] = found.map(court => [court.lat, court.lng])
      if (location) points.push([location.lat, location.lng])
      if (points.length > 0) {
        view.fitBounds(latLngBounds(points), { padding: [36, 36], maxZoom: 14 })
      } else {
        view.setView([40.44, -79.95], 11)
      }

      if (location) {
        circleMarker([location.lat, location.lng], { radius: 8, color: '#ffffff', weight: 2, fillColor: '#3b82f6', fillOpacity: 0.9 })
          .addTo(view)
          .bindTooltip('You are here (approximate)')
      }
      found.forEach((court, index) => {
        marker([court.lat, court.lng], {
          title: court.name,
          icon: divIcon({
            className: '',
            html: `<span class="grid h-8 w-8 place-items-center rounded-full border-2 border-[#17231b] bg-[#d7fc83] font-bold text-[#17231b]">${index + 1}</span>`,
            iconSize: [32, 32],
            iconAnchor: [16, 16],
          }),
        }).addTo(view).on('click', () => onSelect(court))
      })
    }).catch(error => console.warn('Court map unavailable', error))
    return () => { disposed = true; remove?.() }
  }, [found, location, onSelect])

  return <div ref={container} role="region" aria-label="Nearby tennis courts map" className="relative z-0 h-[360px] min-w-0 rounded-2xl bg-[#202c25] lg:h-[500px]" />
}

function CourtAttributes({ court }: { court: DiscoveredCourt }) {
  // Show an attribute ONLY when OpenStreetMap actually carries it.
  const rows: [string, string][] = []
  if (court.surface) rows.push(['Surface', court.surface])
  if (court.lights) rows.push(['Lights', court.lights === 'lit' ? 'Lit' : 'No lights listed'])
  if (court.access) rows.push(['Access', court.access])
  if (court.indoor !== undefined) rows.push(['Setting', court.indoor ? 'Indoor' : 'Outdoor'])
  if (rows.length === 0) {
    return <p className="text-sm text-white/60">No surface, lighting, or access details are listed for this court in OpenStreetMap — they may still be worth a visit.</p>
  }
  return (
    <dl className="grid grid-cols-2 gap-2 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="rounded-lg bg-white/5 px-3 py-2">
          <dt className="text-[11px] font-bold uppercase tracking-wider text-white/45">{label}</dt>
          <dd className="mt-0.5 capitalize text-white/85">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function NearbyCourts() {
  const [location, setLocation] = useState<LatLng | null>(null)
  const [locationLabel, setLocationLabel] = useState('')
  const [radiusKm, setRadiusKm] = useState(10)
  const [placeQuery, setPlaceQuery] = useState('')
  const [places, setPlaces] = useState<GeocodedPlace[]>([])
  const [searchingPlaces, setSearchingPlaces] = useState(false)
  const [found, setFound] = useState<DiscoveredCourt[]>([])
  const [selected, setSelected] = useState<DiscoveredCourt | null>(null)
  const [status, setStatus] = useState<'idle' | 'locating' | 'searching' | 'ready' | 'error'>('idle')
  const [message, setMessage] = useState('Use your location, or search for a place — courts are found through OpenStreetMap, not a booking service.')
  const [searchCount, setSearchCount] = useState(0)

  const searchNearby = useCallback(async (center: LatLng, radius: number) => {
    setStatus('searching')
    setMessage('Searching nearby courts…')
    try {
      const result = await fetchNearbyCourts(center, radius)
      const sorted = [...result.courts].sort((a, b) => haversineMiles(center, a) - haversineMiles(center, b))
      setFound(sorted)
      stashDiscoveredCourts(sorted)
      setSelected(sorted[0] ?? null)
      setSearchCount(count => count + 1)
      setStatus('ready')
      setMessage(
        sorted.length === 0
          ? 'No tennis courts are mapped in OpenStreetMap within this radius. Try a larger radius or the Pittsburgh courts.'
          : `${sorted.length} court${sorted.length === 1 ? '' : 's'} found within ${radius} km (straight-line distance).`,
      )
    } catch (cause) {
      setStatus('error')
      setMessage(cause instanceof Error ? cause.message : 'Court search failed. You can still browse the Pittsburgh courts.')
    }
  }, [])

  async function locate() {
    setStatus('locating')
    setMessage('Finding your location…')
    try {
      const point = await requestOneShotLocation()
      setLocation(point)
      setLocationLabel('Your current location')
      await searchNearby(point, radiusKm)
    } catch (cause) {
      setStatus('error')
      setMessage(cause instanceof Error ? cause.message : 'Could not get your location. Search by place name instead.')
    }
  }

  async function searchPlace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const query = placeQuery.trim()
    if (query.length < 2) {
      setMessage('Enter at least 2 characters for a place name.')
      return
    }
    setSearchingPlaces(true)
    setMessage('Searching for that place…')
    try {
      const result = await searchPlaces(query)
      setPlaces(result.results)
      if (result.results.length === 0) {
        setMessage('No place matched that name. Try a city or neighbourhood.')
      } else {
        setMessage(`${result.results.length} place${result.results.length === 1 ? '' : 's'} found — pick one to search for courts nearby.`)
      }
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Place search failed. Try again in a moment.')
    } finally {
      setSearchingPlaces(false)
    }
  }

  async function choosePlace(place: GeocodedPlace) {
    const point = { lat: place.lat, lng: place.lng }
    setLocation(point)
    setLocationLabel(place.displayName)
    setPlaces([])
    await searchNearby(point, radiusKm)
  }

  function changeRadius(next: number) {
    const radius = clampRadiusKm(next)
    setRadiusKm(radius)
    if (location && status === 'ready') void searchNearby(location, radius)
  }

  const mapKey = `${searchCount}:${location?.lat ?? 0}:${location?.lng ?? 0}`

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={status === 'locating' || status === 'searching'} onClick={() => void locate()} className="inline-flex items-center gap-2 rounded-xl bg-[#d7fc83] px-4 py-3 text-sm font-bold text-[#101a13] disabled:opacity-50">
          <LocateFixed size={18} /> {status === 'locating' ? 'Finding location…' : 'Find courts near me'}
        </button>
        <label className="flex items-center gap-2 text-sm text-white/75">
          Radius
          <select value={radiusKm} disabled={status === 'searching'} onChange={e => changeRadius(Number(e.target.value))} className="rounded-xl border border-white/15 bg-[#0e1513] px-3 py-2.5 text-sm text-white outline-none">
            {RADIUS_OPTIONS_KM.map(km => <option key={km} value={km}>{km} km</option>)}
          </select>
        </label>
        {location && <span className="text-xs text-white/55">Searching around: {locationLabel}</span>}
      </div>

      <form onSubmit={e => void searchPlace(e)} className="flex flex-wrap gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Search by place name</span>
          <input
            value={placeQuery}
            onChange={e => setPlaceQuery(e.target.value)}
            placeholder="Or search by place — e.g. Boston, MA"
            maxLength={200}
            className="w-full rounded-xl border border-white/15 bg-[#0e1513] px-3.5 py-3 text-sm text-white outline-none placeholder:text-white/35 focus:border-[#d7fc83]"
          />
        </label>
        <button type="submit" disabled={searchingPlaces} className="inline-flex items-center gap-2 rounded-xl border border-white/20 px-4 py-3 text-sm font-semibold disabled:opacity-50">
          <Search size={16} /> {searchingPlaces ? 'Searching…' : 'Search place'}
        </button>
      </form>
      {places.length > 0 && (
        <ul className="space-y-2" aria-label="Matching places">
          {places.map(place => (
            <li key={`${place.lat},${place.lng}:${place.displayName}`}>
              <button type="button" onClick={() => void choosePlace(place)} className="flex w-full items-center gap-3 rounded-xl border border-white/15 px-3 py-3 text-left text-sm hover:border-[#d7fc83]/60">
                <MapPin size={16} className="shrink-0 text-[#d7fc83]" />
                <span className="flex-1">{place.displayName}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <p role="status" className="text-sm text-white/65">{message}</p>

      {status === 'searching' || status === 'locating' ? (
        <div role="status" aria-busy="true" className="space-y-3">
          {[1, 2, 3].map(n => <div key={n} className="h-20 animate-pulse rounded-2xl bg-white/5" />)}
        </div>
      ) : found.length > 0 ? (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
          <div key={mapKey}><DiscoveryMap courts={found} location={location} onSelect={setSelected} /></div>
          <div className="min-w-0 space-y-4">
            {selected && (
              <section className="rounded-2xl border border-white/15 bg-[#141b1a] p-5" aria-label="Selected court">
                <h2 className="text-xl font-bold">{selected.name}</h2>
                <p className="mt-1 text-sm text-white/70">
                  {selected.locality ?? 'OpenStreetMap'} {location && `· ${formatDistanceMiles(haversineMiles(location, selected))} away (straight line)`}
                </p>
                <div className="mt-4"><CourtAttributes court={selected} /></div>
                <p className="mt-3 text-xs text-white/50">
                  Court data is community-mapped and may be incomplete or out of date. Availability is not shown — we never claim a court is free without a real source.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <a
                    href={`https://www.openstreetmap.org/directions?to=${selected.lat}%2C${selected.lng}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 rounded-xl bg-[#d7fc83] px-4 py-3 text-sm font-bold text-[#101a13]"
                  >
                    <Navigation size={16} /> Directions
                  </a>
                  <Link
                    to={`/rallies?courtName=${encodeURIComponent(selected.name)}&courtArea=${encodeURIComponent(selected.locality ?? 'OpenStreetMap')}`}
                    className="rounded-xl border border-white/20 px-4 py-3 text-sm font-semibold"
                  >
                    Plan a Rally here
                  </Link>
                </div>
              </section>
            )}
            <ul className="space-y-2" aria-label="Nearby courts">
              {found.map((court, index) => (
                <li key={court.id}>
                  <button type="button" onClick={() => setSelected(court)} aria-pressed={selected?.id === court.id} className="flex w-full items-center gap-3 rounded-xl border border-white/15 px-3 py-3 text-left text-sm aria-pressed:border-[#d7fc83]">
                    <MapPin size={16} className="shrink-0 text-[#d7fc83]" />
                    <span className="flex-1">{index + 1}. {court.name}</span>
                    {location && <span className="shrink-0 text-white/65">{formatDistanceMiles(haversineMiles(location, court))}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : status === 'ready' ? (
        <div className="rounded-2xl border border-dashed border-white/20 p-10 text-center">
          <p className="text-sm font-bold">No courts mapped nearby</p>
          <p className="mt-2 text-xs leading-relaxed text-white/50">OpenStreetMap coverage varies by area. Try a larger radius, a different place, or the Pittsburgh courts.</p>
        </div>
      ) : null}

      <p className="text-xs text-white/40">
        Court data © <a className="underline" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a> (ODbL).
        Your location is used once to run the search and is never saved. Distances are straight-line, not road distances.
      </p>
    </div>
  )
}

function PittsburghCourts() {
  const [selected, setSelected] = useState(courts[0])
  const [location, setLocation] = useState<Point>()
  const [locationStatus, setLocationStatus] = useState('')
  const [locating, setLocating] = useState(false)
  const listed = courts.map((court, index) => ({
    court, index, distance: location ? distanceMiles(location, court) : undefined,
  })).sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0))

  function locate() {
    if (!navigator.geolocation) {
      setLocationStatus('Location is unavailable. You can still browse the Pittsburgh courts.')
      return
    }
    setLocating(true)
    setLocationStatus('')
    navigator.geolocation.getCurrentPosition(({ coords }) => {
      setLocation({ lat: coords.latitude, lng: coords.longitude })
      setLocationStatus('Courts sorted by straight-line distance.')
      setLocating(false)
    }, () => {
      setLocationStatus('Could not get your location. You can still browse the Pittsburgh courts.')
      setLocating(false)
    }, { timeout: 8000, maximumAge: 60000 })
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={locating} onClick={locate} className="inline-flex items-center gap-2 rounded-xl border border-white/20 px-4 py-3 text-sm font-semibold">
          <LocateFixed size={18} /> {locating ? 'Finding location…' : 'Use my location'}
        </button>
        <p className="text-sm text-white/65">Three City of Pittsburgh courts with official booking links. These stay available as a fallback when discovery has no results.</p>
      </div>
      <p role="status" className="text-sm text-white/65">{locationStatus}</p>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <CourtMap onSelect={setSelected} />
        <div className="min-w-0 space-y-4">
          <section className="rounded-2xl border border-white/15 bg-[#141b1a] p-5" aria-label="Selected court">
            <h2 className="text-xl font-bold">{selected.name}</h2>
            <p className="mt-1 text-sm text-white/70">{selected.area}</p>
            <p className="mt-3 text-sm text-white/70">
              Check the official schedule for permit times. Pittsburgh does not offer same-day tennis permits, and walk-on occupancy can change.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <a href={selected.bookingUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-xl bg-[#d7fc83] px-4 py-3 text-sm font-bold text-[#101a13]">
                {selected.directCalendar ? 'Open court calendar' : 'Open city booking'} <ArrowUpRight size={16} />
              </a>
              <Link to={`/rallies?court=${selected.id}`} className="rounded-xl border border-white/20 px-4 py-3 text-sm font-semibold">
                Plan a Rally here
              </Link>
            </div>
          </section>
          <ul className="space-y-2" aria-label="Pittsburgh courts">
            {listed.map(({ court, index, distance }) => (
              <li key={court.id}>
                <button type="button" onClick={() => setSelected(court)} aria-pressed={selected.id === court.id} className="flex w-full items-center gap-3 rounded-xl border border-white/15 px-3 py-3 text-left text-sm aria-pressed:border-[#d7fc83]">
                  <MapPin size={16} className="shrink-0 text-[#d7fc83]" />
                  <span className="flex-1">{index + 1}. {court.name}</span>
                  {distance !== undefined && <span className="shrink-0 text-white/65">{distance.toFixed(1)} mi</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

export default function CourtsPage() {
  const [tab, setTab] = useState<'nearby' | 'pittsburgh'>('nearby')

  return (
    <main className="min-h-screen bg-[#0b110f] text-white">
      <div className="mx-auto max-w-7xl space-y-6 px-4 py-10 sm:px-8">
        <header>
          <h1 className="text-4xl font-black tracking-tight">Find a court</h1>
          <p className="mt-2 text-white/70">Discover tennis courts near you through OpenStreetMap, or browse the Pittsburgh courts with official booking links.</p>
        </header>
        <div className="flex gap-2" role="tablist" aria-label="Court sources">
          {([
            { id: 'nearby', label: 'Courts near me' },
            { id: 'pittsburgh', label: 'Pittsburgh courts' },
          ] as const).map(({ id, label }) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`rounded-full px-4 py-2 text-xs font-bold ${tab === id ? 'bg-[#d7fc83] text-[#0e180f]' : 'bg-white/5 text-white/55 hover:bg-white/10'}`}>
              {label}
            </button>
          ))}
        </div>
        {tab === 'nearby' ? <NearbyCourts /> : <PittsburghCourts />}
      </div>
    </main>
  )
}
