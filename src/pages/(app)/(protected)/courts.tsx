import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight, LocateFixed, MapPin, Navigation, Search } from 'lucide-react'
import PittsburghCourts from '@/components/PittsburghCourts'
import CourtDiscoveryMap, { CourtMapLayout } from '@/components/CourtDiscoveryMap'
import { fetchNearbyCourts, searchPlaces } from '@/lib/court-discovery-client'
import { clampRadiusKm, DEFAULT_RADIUS_KM, formatDistanceMiles, haversineMiles, RADIUS_OPTIONS_KM, type LatLng } from '@/lib/geo'
import { requestOneShotLocation } from '@/lib/location'
import type { DiscoveredCourt, GeocodedPlace } from '@/lib/osm'

const DISCOVERED_STORAGE_KEY = 'rallycircle:discovered-courts'

/** Remember discovered courts for this tab only, so Find Games can offer distances for them. Ephemeral, never a record. */
function stashDiscoveredCourts(found: DiscoveredCourt[]): void {
  try {
    sessionStorage.setItem(DISCOVERED_STORAGE_KEY, JSON.stringify(found))
  } catch {
    // Private mode / quota: distance matching in Find Games simply falls back to Pittsburgh courts.
  }
}

function CourtAttributes({ court }: { court: DiscoveredCourt }) {
  // Show an attribute ONLY when OpenStreetMap actually carries it.
  const rows: [string, string][] = []
  if (court.surface) rows.push(['Surface', court.surface])
  if (court.lights) rows.push(['Lights', court.lights === 'lit' ? 'Lit' : 'Unlit'])
  if (court.access) rows.push(['Access', court.access])
  if (court.indoor !== undefined) rows.push(['Setting', court.indoor ? 'Indoor' : 'Outdoor'])
  if (rows.length === 0) {
    return <p className="text-sm text-white/60">No surface, lighting, or access details are listed for this court in OpenStreetMap.</p>
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

function NearbyCourts({ active }: { active: boolean }) {
  const [location, setLocation] = useState<LatLng | null>(null)
  const [locationLabel, setLocationLabel] = useState('')
  const [radiusKm, setRadiusKm] = useState(DEFAULT_RADIUS_KM)
  const [placeQuery, setPlaceQuery] = useState('')
  const [places, setPlaces] = useState<GeocodedPlace[]>([])
  const [searchingPlaces, setSearchingPlaces] = useState(false)
  const [found, setFound] = useState<DiscoveredCourt[]>([])
  const [selected, setSelected] = useState<DiscoveredCourt | null>(null)
  const [status, setStatus] = useState<'idle' | 'locating' | 'searching' | 'ready' | 'error'>('idle')
  const [message, setMessage] = useState('Search by place or share an approximate location with OpenStreetMap services to find mapped courts.')
  const activeRequest = useRef<AbortController | null>(null)
  useEffect(() => () => activeRequest.current?.abort(), [])

  const startRequest = useCallback(() => {
    activeRequest.current?.abort()
    setSearchingPlaces(false)
    const controller = new AbortController()
    activeRequest.current = controller
    return controller.signal
  }, [])
  const busy = searchingPlaces || status === 'locating' || status === 'searching'

  const searchNearby = useCallback(async (center: LatLng, radius: number, signal = startRequest()) => {
    setFound([])
    setSelected(null)
    setStatus('searching')
    setMessage('Searching nearby courts…')
    try {
      const result = await fetchNearbyCourts(center, radius, signal)
      if (signal.aborted) return
      const sorted = [...result.courts].sort((a, b) => haversineMiles(center, a) - haversineMiles(center, b))
      setFound(sorted)
      stashDiscoveredCourts(sorted)
      setSelected(sorted[0] ?? null)
      setStatus('ready')
      setMessage(
        sorted.length === 0
          ? 'No tennis courts are mapped in OpenStreetMap within this radius. Try a larger radius or the Pittsburgh courts.'
          : `${sorted.length} court${sorted.length === 1 ? '' : 's'} found within ${radius} km (straight-line distance).`,
      )
    } catch (cause) {
      if (signal.aborted) return
      setStatus('error')
      setMessage(cause instanceof Error ? cause.message : 'Court search failed. You can still browse the Pittsburgh courts.')
    }
  }, [startRequest])

  async function locate() {
    const signal = startRequest()
    setFound([])
    setSelected(null)
    setLocation(null)
    setStatus('locating')
    setMessage('Finding your location…')
    try {
      const point = await requestOneShotLocation()
      if (signal.aborted) return
      setLocation(point)
      setLocationLabel('Your current location')
      await searchNearby(point, radiusKm, signal)
    } catch (cause) {
      if (signal.aborted) return
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
    const signal = startRequest()
    setPlaces([])
    setSearchingPlaces(true)
    setMessage('Searching for that place…')
    try {
      const result = await searchPlaces(query, signal)
      if (signal.aborted) return
      setPlaces(result.results)
      if (result.results.length === 0) {
        setMessage('No place matched that name. Try a city or neighbourhood.')
      } else {
        setMessage(`${result.results.length} place${result.results.length === 1 ? '' : 's'} found — pick one to search for courts nearby.`)
      }
    } catch (cause) {
      if (!signal.aborted) setMessage(cause instanceof Error ? cause.message : 'Place search failed. Try again in a moment.')
    } finally {
      if (!signal.aborted) setSearchingPlaces(false)
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
    if (location) void searchNearby(location, radius)
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={busy} onClick={() => void locate()} className="inline-flex items-center gap-2 rounded-xl bg-[#d7fc83] px-4 py-3 text-sm font-bold text-[#101a13] disabled:opacity-50">
          <LocateFixed size={18} /> {status === 'locating' ? 'Finding location…' : 'Find courts near me'}
        </button>
        <label className="flex items-center gap-2 text-sm text-white/75">
          Radius
          <select value={radiusKm} disabled={busy} onChange={e => changeRadius(Number(e.target.value))} className="rounded-xl border border-white/15 bg-[#0e1513] px-3 py-2.5 text-sm text-white focus-visible:outline-2 focus-visible:outline-[#d7fc83]">
            {RADIUS_OPTIONS_KM.map(km => <option key={km} value={km}>{km} km</option>)}
          </select>
        </label>
        {location && <span className="min-w-0 break-words text-xs text-white/75">Search area: {locationLabel}</span>}
      </div>

      <form onSubmit={e => void searchPlace(e)} className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 grow basis-48">
          <span className="block pb-1 text-sm font-semibold text-white/85">City or neighbourhood</span>
          <input
            value={placeQuery}
            onChange={e => setPlaceQuery(e.target.value)}
            placeholder="Search by place, e.g. Boston, MA"
            maxLength={200}
            type="search"
            className="w-full rounded-xl border border-white/15 bg-[#0e1513] px-3.5 py-3 text-sm text-white placeholder:text-white/50 focus-visible:outline-2 focus-visible:outline-[#d7fc83]"
          />
        </label>
        <button type="submit" disabled={busy} className="inline-flex items-center gap-2 rounded-xl border border-white/20 px-4 py-3 text-sm font-semibold disabled:opacity-50">
          <Search size={16} /> {searchingPlaces ? 'Searching…' : 'Search place'}
        </button>
      </form>
      {places.length > 0 && (
        <ul className="space-y-2" aria-label="Matching places">
          {places.map(place => (
            <li key={`${place.lat},${place.lng}:${place.displayName}`}>
              <button type="button" disabled={busy} onClick={() => void choosePlace(place)} className="flex w-full items-center gap-3 rounded-xl border border-white/15 px-3 py-3 text-left text-sm hover:border-[#d7fc83]/60">
                <MapPin size={16} className="shrink-0 text-[#d7fc83]" />
                <span className="min-w-0 flex-1 break-words">{place.displayName}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <p role="status" className="text-sm text-white/75">{message}</p>
      {status === 'error' && location && (
        <button type="button" className="min-h-11 rounded-lg border border-white/25 px-3 text-sm font-semibold focus-visible:outline-2" disabled={busy} onClick={() => void searchNearby(location, radiusKm)}>Retry court search</button>
      )}

      {status === 'searching' || status === 'locating' ? (
        <div aria-hidden className="space-y-3">
          {[1, 2, 3].map(n => <div key={n} className="h-20 motion-safe:animate-pulse rounded-2xl bg-white/5" />)}
        </div>
      ) : found.length > 0 ? (
        <CourtMapLayout map={active && <CourtDiscoveryMap courts={found} location={location} label="Nearby tennis courts map" selectedId={selected?.id} onSelect={setSelected} />}
          details={selected && (
              <section className="rounded-2xl border border-white/15 bg-[#141b1a] p-5" aria-label="Selected court">
                <h2 className="break-words text-xl font-bold">{selected.name}</h2>
                <p className="mt-1 text-sm text-white/70">
                  {selected.locality ?? 'OpenStreetMap'} {location && `· ${formatDistanceMiles(haversineMiles(location, selected))} away (straight line)`}
                </p>
                <div className="mt-4"><CourtAttributes court={selected} /></div>
                <p className="mt-3 text-xs text-white/50">
                  Check the venue for access and availability before you go.
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
          )}>
            <ul className="space-y-2" aria-label="Nearby courts">
              {found.map((court, index) => (
                <li key={court.id}>
                  <button type="button" onClick={() => setSelected(court)} aria-pressed={selected?.id === court.id} className="flex w-full items-center gap-3 rounded-xl border border-white/15 px-3 py-3 text-left text-sm aria-pressed:border-[#d7fc83]">
                    <MapPin size={16} className="shrink-0 text-[#d7fc83]" />
                    <span className="min-w-0 flex-1 break-words">{index + 1}. {court.name}</span>
                    {location && <span className="shrink-0 text-white/65">{formatDistanceMiles(haversineMiles(location, court))}</span>}
                  </button>
                </li>
              ))}
            </ul>
        </CourtMapLayout>
      ) : status === 'ready' ? (
        <div className="rounded-2xl border border-dashed border-white/20 p-10 text-center">
          <p className="text-sm font-bold">No courts mapped nearby</p>
          <p className="mt-2 text-xs leading-relaxed text-white/50">OpenStreetMap coverage varies by area. Try a larger radius, a different place, or the Pittsburgh courts.</p>
        </div>
      ) : null}

      <p className="text-xs text-white/40">
        Court data © <a className="underline" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a> (ODbL).
        Nearby search uses your shared location once per request. Distances are straight-line estimates.
      </p>
    </div>
  )
}

export default function CourtsPage() {
  const [tab, setTab] = useState<'nearby' | 'pittsburgh'>('pittsburgh')
  const [nearbyOpened, setNearbyOpened] = useState(false)
  function showSource(source: 'nearby' | 'pittsburgh') {
    if (source === 'nearby') setNearbyOpened(true)
    setTab(source)
  }

  return (
    <div className="min-h-screen bg-[#0b110f] text-white">
      <div className="mx-auto max-w-7xl space-y-6 px-4 py-10 sm:px-8">
        <header>
          <h1 className="text-4xl font-black tracking-tight">Find a court</h1>
          <p className="mt-2 text-white/70">Discover tennis courts near you through OpenStreetMap, or browse the Pittsburgh courts with official booking links.</p>
        </header>
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Court sources" onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const next = event.key === 'Home' ? 'nearby' : event.key === 'End' ? 'pittsburgh' : tab === 'nearby' ? 'pittsburgh' : 'nearby'
          showSource(next)
          event.currentTarget.querySelector<HTMLButtonElement>(`#court-tab-${next}`)?.focus()
        }}>
          {([
            { id: 'nearby', label: 'Courts near me' },
            { id: 'pittsburgh', label: 'Pittsburgh courts' },
          ] as const).map(({ id, label }) => (
            <button key={id} type="button" role="tab" id={`court-tab-${id}`} aria-controls={`court-source-${id}`} tabIndex={tab === id ? 0 : -1} aria-selected={tab === id} onClick={() => showSource(id)} className={`min-h-11 rounded-full px-4 py-2 focus-visible:outline-2 text-xs font-bold ${tab === id ? 'bg-[#d7fc83] text-[#0e180f]' : 'bg-white/5 text-white/55 hover:bg-white/10'}`}>
              {label}
            </button>
          ))}
        </div>
        <div role="tabpanel" id="court-source-nearby" aria-labelledby="court-tab-nearby" hidden={tab !== 'nearby'}>
          {nearbyOpened && <NearbyCourts active={tab === 'nearby'} />}
        </div>
        <div role="tabpanel" id="court-source-pittsburgh" aria-labelledby="court-tab-pittsburgh" hidden={tab !== 'pittsburgh'}>
          <PittsburghCourts active={tab === 'pittsburgh'} />
        </div>
      </div>
    </div>
  )
}
