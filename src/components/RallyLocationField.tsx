import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { MapPin, Search } from 'lucide-react'
import CourtDiscoveryMap from './CourtDiscoveryMap'
import { fetchNearbyCourts, searchPlaces } from '@/lib/court-discovery-client'
import { parseRallyPlace, serializeRallyPlace, type RallyPlace } from '@/lib/rally-place'
import type { GeocodedPlace } from '@/lib/osm'
import { combinePlaceChoices, placeArea, placeFromCourt, placeFromGeocoder } from '@/lib/rally-place-selection'

export interface RallyLocationFields { court: string; location: string; courtPlace: string }
interface Props extends RallyLocationFields {
  onChange: (next: RallyLocationFields) => void
  disabled?: boolean
}
const input = 'min-h-11 w-full min-w-0 rounded-xl border border-[#738078] bg-[#0e1513] px-3 py-2.5 text-base text-white sm:text-sm'
const button = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/25 px-3 py-2 text-sm font-semibold text-white hover:bg-white/5 disabled:opacity-50'

/** Submitted searches reuse the cached worker adapter; never geocode each keystroke. */
export default function RallyLocationField({ court, location, courtPlace, onChange, disabled = false }: Props) {
  const id = useId()
  const selected = useMemo(() => parseRallyPlace(courtPlace), [courtPlace])
  const [query, setQuery] = useState('')
  const [places, setPlaces] = useState<GeocodedPlace[]>([])
  const [origin, setOrigin] = useState<RallyPlace | null>(null)
  const [courts, setCourts] = useState<RallyPlace[]>([])
  const [candidate, setCandidate] = useState<RallyPlace | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)
  const emittedFields = useRef<RallyLocationFields | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  const points = useMemo(() => origin ? combinePlaceChoices(origin, courts) : selected ? [selected] : [], [origin, courts, selected])
  const preview = points.find(point => point.id === candidate?.id) ?? candidate ?? selected

  const resetSearch = useCallback(() => {
    request.current?.abort()
    setBusy(false); setPlaces([]); setCourts([]); setOrigin(null); setCandidate(null); setError(''); setNotice('')
  }, [])
  // A new discovery link or sample draft replaces the location from outside
  // this field. Discard an older preview and abort its pending response too.
  useEffect(() => {
    const emitted = emittedFields.current
    emittedFields.current = null
    if (emitted?.court === court && emitted.location === location && emitted.courtPlace === courtPlace) return
    resetSearch()
  }, [court, location, courtPlace, resetSearch])

  function emit(next: RallyLocationFields) {
    emittedFields.current = next
    onChange(next)
  }

  async function search() {
    if (disabled) return
    resetSearch()
    const value = query.trim()
    if (value.length < 2 || value.length > 200) { setError('Enter a court, park, address or city between 2 and 200 characters.'); return }
    const controller = new AbortController()
    request.current = controller
    setBusy(true); setNotice('Searching places…')
    try {
      const result = await searchPlaces(value, controller.signal)
      if (controller.signal.aborted) return
      setPlaces(result.results)
      setNotice(result.results.length ? 'Choose a place to preview it and find nearby tennis courts.' : 'No matching places. Try a court name with its city, or enter the location below.')
    } catch (cause) {
      if (!controller.signal.aborted) { setNotice(''); setError(cause instanceof Error ? cause.message : 'Place search failed. Try again or enter the location below.') }
    } finally { if (!controller.signal.aborted) setBusy(false) }
  }

  async function choosePlace(place: GeocodedPlace) {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    const next = placeFromGeocoder(place)
    if (!next) { setError('This place has invalid coordinates. Choose another search result.'); return }
    setPlaces([]); setOrigin(next); setCandidate(next); setCourts([]); setError(''); setBusy(true); setNotice('Finding tennis courts near this place…')
    try {
      const result = await fetchNearbyCourts(place, 5, controller.signal)
      if (controller.signal.aborted) return
      const nearby = result.courts.map(c => placeFromCourt(c, next.address)).filter((c): c is RallyPlace => c !== null)
      setCourts(nearby)
      setCandidate(current => nearby.find(court => court.id === current?.id) ?? current)
      setNotice(result.courts.length ? 'Choose a tennis court or the searched place, then select Use this location.' : 'No tennis courts mapped within 5 km. You can confirm this place, search another area, or enter a location below.')
    } catch {
      if (!controller.signal.aborted) setNotice('Nearby courts could not load. You can confirm this place or search again.')
    } finally { if (!controller.signal.aborted) setBusy(false) }
  }

  function confirmLocation() {
    if (!candidate || disabled) return
    const chosen = points.find(point => point.id === candidate.id) ?? candidate
    emit({ court: chosen.name, location: placeArea(chosen), courtPlace: serializeRallyPlace(chosen) })
    resetSearch()
    setNotice('Location selected. The map pin will be saved with this rally.')
  }

  function changeText(next: Partial<Pick<RallyLocationFields, 'court' | 'location'>>) {
    resetSearch()
    emit({ court, location, ...next, courtPlace: '' })
  }

  return <fieldset disabled={disabled} className="min-w-0 space-y-4 rounded-xl border border-white/15 p-4">
    <legend className="px-1 text-sm font-semibold text-white">Court location</legend>
    <p className="text-xs leading-relaxed text-white/75">Search any city for a court, park or place. Choose a result to add a map pin, or enter a location below.</p>
    <div role="search" aria-label="Rally location search" className="flex flex-wrap items-end gap-2">
      <label className="min-w-0 grow basis-48 text-sm" htmlFor={`${id}-search`}>Search courts or places
        <input id={`${id}-search`} type="search" className={`${input} mt-1.5`} value={query} maxLength={200} autoComplete="off" placeholder="Court, park or city" onChange={event => { resetSearch(); setQuery(event.target.value) }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void search() } }} />
      </label>
      <button type="button" className={button} disabled={disabled || busy} onClick={() => void search()}><Search size={16} aria-hidden />{busy ? 'Searching…' : 'Search places'}</button>
    </div>
    <p role="status" className="text-xs leading-relaxed text-white/75">{notice}</p>
    {error && <p role="alert" className="text-sm text-rose-200">{error} You can also enter the court and area below.</p>}
    {places.length > 0 && <ul aria-label="Place suggestions" className="max-h-56 space-y-2 overflow-y-auto overscroll-contain">
      {places.map((place, index) => <li key={`${place.id ?? place.displayName}:${index}`}><button type="button" className={`${button} w-full justify-start text-start font-normal`} onClick={() => void choosePlace(place)}><MapPin size={16} className="shrink-0 text-[#d7fc83]" aria-hidden /><span className="min-w-0 break-words">{place.displayName}</span></button></li>)}
    </ul>}
    {points.length > 0 && preview && <div className="space-y-3" aria-label="Location map preview">
      <CourtDiscoveryMap courts={points} label="Rally location preview" selectedId={preview.id} onSelect={setCandidate} compact />
      {origin && <ul aria-label="Location choices" className="max-h-56 space-y-2 overflow-y-auto overscroll-contain">
        {points.map((place, index) => <li key={place.id}><button type="button" aria-pressed={candidate?.id === place.id} className={`${button} w-full justify-start text-start aria-pressed:border-[#d7fc83] aria-pressed:bg-[#d7fc83]/10`} onClick={() => setCandidate(place)}><span className="grid size-7 shrink-0 place-items-center rounded-full bg-white/10 text-xs tabular-nums">{index + 1}</span><span className="min-w-0 break-words"><span className="block">{place.name}</span><span className="block text-xs font-normal text-white/75">{index === 0 ? 'Searched place · ' : 'Tennis court · '}{place.address}</span></span></button></li>)}
      </ul>}
      <div className="space-y-2 rounded-lg bg-white/5 p-3">
        <p className="break-words text-sm font-semibold">{candidate ? 'Preview: ' : 'Selected location: '}{preview.name}</p>
        <p className="break-words text-xs leading-relaxed text-white/75">{preview.address}</p>
        <p className="text-xs tabular-nums text-white/75">{preview.lat.toFixed(6)}, {preview.lng.toFixed(6)}</p>
        {candidate ? <button type="button" className={`${button} border-[#d7fc83] bg-[#d7fc83] text-[#101a13] hover:bg-[#ebffb8]`} onClick={confirmLocation}>Use this location</button>
          : <button type="button" className={button} onClick={() => { resetSearch(); emit({ court, location, courtPlace: '' }); setNotice('Map pin removed. The court and area stay as text.') }}>Remove map pin</button>}
      </div>
    </div>}
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      <label className="min-w-0 text-sm">Court<input required maxLength={100} className={`${input} mt-1.5`} value={court} placeholder="Court or venue name" onChange={event => changeText({ court: event.target.value })} /></label>
      <label className="min-w-0 text-sm">Area<input required maxLength={100} className={`${input} mt-1.5`} value={location} placeholder="City or neighbourhood" onChange={event => changeText({ location: event.target.value })} /></label>
    </div>
    <p className="text-xs leading-relaxed text-white/65">Editing the court or area removes the pin. Search data: <a className="underline underline-offset-4" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>.</p>
  </fieldset>
}
