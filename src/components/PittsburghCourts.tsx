import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight, LocateFixed, MapPin } from 'lucide-react'
import { courts, matchesCourt, rankCourts, type Court } from '@/lib/courts'
import CourtDiscoveryMap, { CourtMapLayout } from '@/components/CourtDiscoveryMap'
import { requestOneShotLocation } from '@/lib/location'
import { formatDistanceMiles, type LatLng } from '@/lib/geo'

export default function PittsburghCourts({ active = true }: { active?: boolean }) {
  const [selection, setSelected] = useState<Court>()
  const [query, setQuery] = useState('')
  const [location, setLocation] = useState<LatLng>()
  const [locationStatus, setLocationStatus] = useState('')
  const [locating, setLocating] = useState(false)
  const locateButton = useRef<HTMLButtonElement>(null)
  const visibleCourts = useMemo(() => courts.filter(court => matchesCourt(court, query)), [query])
  const listed = useMemo(() => rankCourts(visibleCourts, location).map(({ court, distance }, index) => ({
    court: { ...court, pinNumber: index + 1 },
    distance,
  })), [visibleCourts, location])
  const mapCourts = useMemo(() => listed.map(({ court }) => court), [listed])
  const selected = mapCourts.find(court => court.id === selection?.id) ?? mapCourts[0]

  async function locate() {
    setLocating(true)
    setLocationStatus('')
    try {
      setLocation(await requestOneShotLocation())
      setLocationStatus('Courts sorted by straight-line distance.')
    } catch {
      setLocationStatus('Could not get your location. You can still browse the Pittsburgh courts.')
    } finally {
      setLocating(false)
    }
  }

  function clearLocation() {
    locateButton.current?.focus()
    setLocation(undefined)
    setLocationStatus('Location cleared.')
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-black tracking-tight">Pittsburgh tennis courts</h2>
          <p className="mt-2 text-white/70">Explore Pittsburgh courts and check schedules with the city.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button ref={locateButton} type="button" disabled={locating} onClick={() => void locate()} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/25 px-4 py-2 text-sm font-semibold focus-visible:outline-2">
            <LocateFixed size={18} aria-hidden /> {locating ? 'Finding location…' : location ? 'Update my location' : 'Use my location'}
          </button>
          {location && (
            <button type="button" disabled={locating} onClick={clearLocation} className="min-h-11 rounded-xl border border-white/25 px-4 py-2 text-sm font-semibold focus-visible:outline-2">Clear location</button>
          )}
        </div>
      </header>
      <label className="block max-w-md text-sm font-semibold">
        Search by court or area
        <input type="search" value={query} onChange={event => setQuery(event.target.value)} className="mt-2 w-full rounded-xl border border-white/30 bg-[#141b1a] px-4 py-3 focus-visible:outline-2 focus-visible:outline-[#d7fc83]" />
      </label>
      <p role="status" className="text-sm text-white/65">{locationStatus}</p>
      {!selected ? (
        <div className="rounded-2xl border border-white/15 p-5">
          <p role="status">No Pittsburgh courts match that search.</p>
          <button type="button" className="mt-3 min-h-11 underline underline-offset-4" onClick={() => setQuery('')}>Clear search</button>
        </div>
      ) : <CourtMapLayout map={active && <CourtDiscoveryMap courts={mapCourts} label="Pittsburgh tennis court map" selectedId={selected.id} onSelect={setSelected} />}
        details={
          <section className="rounded-2xl border border-white/15 bg-[#141b1a] p-5" aria-label="Selected court">
            <h3 className="break-words text-xl font-bold">{selected.name}</h3>
            <p className="mt-1 text-sm text-white/70">{selected.area}</p>
            <p className="mt-3 text-sm text-white/70">
              Check the official schedule for permit times. Pittsburgh does not offer same-day tennis permits, and walk-on occupancy can change.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <a href={selected.bookingUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-xl bg-[#d7fc83] px-4 py-3 text-sm font-bold text-[#101a13]">
                {selected.directCalendar ? 'Open court calendar' : 'Open city booking'} <ArrowUpRight size={16} />
              </a>
              <Link to={`/rallies?court=${selected.id}`} className="inline-flex min-h-11 items-center rounded-xl border border-white/25 px-4 py-2 text-sm font-semibold focus-visible:outline-2">
                Plan a Rally here
              </Link>
            </div>
          </section>
        }>
          <ul className="space-y-2" aria-label="Pittsburgh courts">
            {listed.map(({ court, distance }) => (
              <li key={court.id}>
                <button type="button" onClick={() => setSelected(court)} aria-pressed={selected.id === court.id} className="flex w-full items-center gap-3 rounded-xl border border-white/15 px-3 py-3 text-left text-sm aria-pressed:border-[#d7fc83]">
                  <MapPin size={16} className="shrink-0 text-[#d7fc83]" />
                  <span className="min-w-0 flex-1 break-words">{court.pinNumber}. {court.name}</span>
                  {distance !== undefined && <span className="shrink-0 text-white/65">{formatDistanceMiles(distance)}</span>}
                </button>
              </li>
            ))}
          </ul>
      </CourtMapLayout>}
    </div>
  )
}
