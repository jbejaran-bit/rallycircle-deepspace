import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight, LocateFixed, MapPin } from 'lucide-react'
import { courts, distanceMiles, type Court } from '@/lib/courts'
import 'leaflet/dist/leaflet.css'

type Point = { lat: number; lng: number }

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

export default function CourtsPage() {
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
    <main className="min-h-screen bg-[#0b110f] text-white">
      <div className="mx-auto max-w-7xl space-y-6 px-4 py-10 sm:px-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-4xl font-black tracking-tight">Find a court</h1>
            <p className="mt-2 text-white/70">Explore Pittsburgh courts and check schedules with the city.</p>
          </div>
          <button type="button" disabled={locating} onClick={locate} className="inline-flex items-center gap-2 rounded-xl border border-white/20 px-4 py-3 text-sm font-semibold">
            <LocateFixed size={18} /> {locating ? 'Finding location…' : 'Use my location'}
          </button>
        </header>
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
    </main>
  )
}
