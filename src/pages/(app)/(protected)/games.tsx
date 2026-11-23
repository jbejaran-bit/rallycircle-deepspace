import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth, useQuery } from 'deepspace'
import { CalendarDays, ChevronRight, LocateFixed, MapPin, Search, SlidersHorizontal, Users } from 'lucide-react'
import { courts as pittsburghCourts } from '@/lib/courts'
import { DiscoveryRsvp } from '@/components/DiscoveryRsvp'
import { discoveryAction, filterGames, gameStatusLabel, type GameFormat, type GameSort, type KnownCourtLocation } from '@/lib/find-games'
import { formatDistanceMiles, type LatLng } from '@/lib/geo'
import { requestOneShotLocation } from '@/lib/location'
import { formatSessionTime, type Level, type RallyRSVP, type RallySession, type RallyWaitlist } from '@/lib/rally'

const LEVELS: (Level | 'Any level')[] = ['Any level', 'Beginner', 'Intermediate', 'Advanced']
const DISTANCE_OPTIONS = [2, 5, 10, 25]
const field = 'mt-1.5 min-h-11 w-full min-w-0 rounded-xl border border-[#738078] bg-[#0e1513] px-3 py-2.5 text-base sm:text-sm text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d7fc83] disabled:opacity-60'
const label = 'block min-w-0 text-xs font-semibold text-white/80'
const button = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/25 px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d7fc83] hover:bg-white/5 disabled:opacity-60'

/** Courts discovered earlier this tab (courts page) — ephemeral, never a record. */
function loadDiscoveredCourts(): KnownCourtLocation[] {
  try {
    const raw = sessionStorage.getItem('rallycircle:discovered-courts')
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry): entry is { name: string; locality?: unknown; lat: number; lng: number } =>
        typeof entry === 'object' && entry !== null &&
        typeof (entry as Record<string, unknown>).name === 'string' &&
        typeof (entry as Record<string, unknown>).lat === 'number' &&
        typeof (entry as Record<string, unknown>).lng === 'number')
      .map(entry => ({ name: entry.name, lat: entry.lat, lng: entry.lng, locality: typeof entry.locality === 'string' ? entry.locality : undefined }))
  } catch {
    return []
  }
}

export default function GamesPage() {
  const { userId } = useAuth()
  const sessions = useQuery<RallySession>('sessions', { orderBy: 'startsAt', orderDir: 'asc' })
  const rsvps = useQuery<RallyRSVP>('rsvps')
  const waitlist = useQuery<RallyWaitlist>('waitlists', { where: { userId } })
  return <GamesDiscovery userId={userId} sessions={sessions} rsvps={rsvps} waitlist={waitlist} />
}

interface DiscoveryRecords<T> {
  records: { recordId: string; data: T }[]
  status: 'loading' | 'ready' | 'error'
  error?: string
}

export function GamesDiscovery({
  userId, sessions: { records: sessions, status: sessionStatus, error: sessionsError },
  rsvps: { records: rsvps, status: rsvpStatus, error: rsvpError }, waitlist,
}: {
  userId?: string | null
  sessions: DiscoveryRecords<RallySession>
  rsvps: DiscoveryRecords<RallyRSVP>
  waitlist: DiscoveryRecords<RallyWaitlist>
}) {
  const searchField = useRef<HTMLInputElement>(null)
  const locateButton = useRef<HTMLButtonElement>(null)
  const myConfirmedSessions = useMemo(() => new Set(rsvps.filter(row => row.data.userId === userId && row.data.status === 'going').map(row => row.data.sessionId)), [rsvps, userId])
  const queuedSessions = useMemo(() => new Set(waitlist.records.map(row => row.data.sessionId)), [waitlist.records])
  const [knownCourts] = useState<KnownCourtLocation[]>(() => [...pittsburghCourts.map(court => ({ ...court, locality: 'Pittsburgh' })), ...loadDiscoveredCourts()])
  const [availability, setAvailability] = useState<'any' | 'spots' | 'waitlist'>('any')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<GameSort>('soonest')
  const [level, setLevel] = useState<Level | 'Any level'>('Any level')
  const [format, setFormat] = useState<GameFormat>('any')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [maxDistance, setMaxDistance] = useState<number | null>(null)
  const [location, setLocation] = useState<LatLng | null>(null)
  const [locationStatus, setLocationStatus] = useState('')
  const [locating, setLocating] = useState(false)
  const [showCancelled, setShowCancelled] = useState(false)
  const [showPast, setShowPast] = useState(false)

  const dateRangeInvalid = Boolean(fromDate && toDate && fromDate > toDate)
  const extraFilterCount = Number(Boolean(fromDate)) + Number(Boolean(toDate)) + Number(maxDistance !== null) +
    Number(availability !== 'any') + Number(showPast) + Number(showCancelled)
  const hasFilters = Boolean(query.trim()) || level !== 'Any level' || format !== 'any' || extraFilterCount > 0
  const games = useMemo(() => {
    if (sessionStatus !== 'ready' || rsvpStatus !== 'ready' || dateRangeInvalid) return []
    return filterGames(
      sessions,
      rsvps.map(r => r.data),
      {
        query,
        sort,
        level,
        format,
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
        maxDistanceMiles: maxDistance ?? undefined,
        showCancelled,
        showPast,
        availability,
      },
      { userId: userId ?? undefined, userLocation: location ?? undefined, knownCourts },
    )
  }, [sessions, rsvps, sessionStatus, rsvpStatus, dateRangeInvalid, query, sort, level, format, fromDate, toDate, maxDistance, showCancelled, showPast, availability, userId, location, knownCourts])

  async function locate() {
    setLocating(true)
    setLocationStatus('')
    try {
      const point = await requestOneShotLocation()
      setLocation(point)
      setSort('nearest')
      setLocationStatus('Sorted by straight-line distance where court coordinates are known. You can set a distance limit under More filters.')
    } catch (cause) {
      setLocationStatus(cause instanceof Error ? cause.message : 'Could not get your location.')
    } finally {
      setLocating(false)
    }
  }

  function clearLocation() {
    locateButton.current?.focus()
    setLocation(null)
    setMaxDistance(null)
    setSort('soonest')
    setLocationStatus('')
  }

  function clearFilters() {
    searchField.current?.focus()
    setQuery('')
    setFormat('any')
    setLevel('Any level')
    setAvailability('any')
    setFromDate('')
    setToDate('')
    setShowPast(false)
    setShowCancelled(false)
    setMaxDistance(null)
  }

  const loading = sessionStatus === 'loading' || rsvpStatus === 'loading'
  const failed = sessionStatus === 'error' || rsvpStatus === 'error'
  const error = sessionStatus === 'error' ? sessionsError : rsvpError

  return (
    <div className="min-h-screen bg-[#0b110f] text-white">
      <div className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-8 lg:py-10">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#d7fc83]">Find your hitting partners</p>
            <h1 className="text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">Find a game</h1>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-white/75">Find rallies in any city by court or area, or get your own group together.</p>
          </div>
          <Link className={button} to="/rallies?create=1">Create a rally</Link>
        </header>

        <section aria-labelledby="game-filter-heading" className="rounded-2xl border border-white/15 bg-[#141b1a] p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="game-filter-heading" className="text-lg font-bold">Search games</h2>
            {hasFilters && <button type="button" onClick={clearFilters} className={button}>Clear filters</button>}
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(2,minmax(0,1fr))]">
            <label className={label}>
              Rally title, court or area
              <span className="relative block">
                <Search size={16} aria-hidden className="pointer-events-none absolute left-3 top-5 text-white/55" />
                <input ref={searchField} type="search" maxLength={120} value={query} onChange={e => setQuery(e.target.value)} placeholder="e.g. Schenley, Oakland" className={`${field} pl-9 placeholder:text-white/50`} />
              </span>
            </label>
            <label className={label}>
              Format
              <select value={format} onChange={e => setFormat(e.target.value as GameFormat)} className={field}>
                <option value="any">Any format</option>
                <option value="singles">Singles</option>
                <option value="doubles">Doubles</option>
                <option value="practice">Practice</option>
              </select>
            </label>
            <label className={label}>
              Skill level
              <select value={level} onChange={e => setLevel(e.target.value as Level | 'Any level')} className={field}>
                {LEVELS.map(item => <option key={item}>{item}</option>)}
              </select>
            </label>
          </div>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <button ref={locateButton} type="button" disabled={locating} onClick={() => void locate()} className={button}>
              <LocateFixed size={16} aria-hidden /> {locating ? 'Finding location…' : location ? 'Update my location' : 'Use my location'}
            </button>
            {location && <button type="button" disabled={locating} onClick={clearLocation} className={button}>Clear location</button>}
            <label className={`${label} grow sm:grow-0`}>
              Sort by
              <select value={sort} onChange={e => setSort(e.target.value as GameSort)} className={field}>
                <option value="soonest">Start time</option>
                <option value="nearest" disabled={!location}>Nearest court</option>
              </select>
            </label>
          </div>
          {locationStatus && <p role="status" className="mt-3 text-sm text-white/75">{locationStatus}</p>}
          <details className="mt-4 border-t border-white/15 pt-2">
            <summary className="min-h-11 cursor-pointer rounded-xl px-2 py-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-[#d7fc83]">
              <SlidersHorizontal size={16} aria-hidden className="mx-2 inline text-[#d7fc83]" />More filters{extraFilterCount ? ` (${extraFilterCount} active)` : ''}
            </summary>
            <div className="mt-2 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <label className={label}>
                Places
                <select value={availability} onChange={e => setAvailability(e.target.value as typeof availability)} className={field}>
                  <option value="any">Any availability</option>
                  <option value="spots">Places available</option>
                  <option value="waitlist">Full with waitlist</option>
                </select>
              </label>
              <label className={label}>
                Within distance
                <select value={maxDistance ?? ''} disabled={!location} onChange={e => setMaxDistance(e.target.value ? Number(e.target.value) : null)} className={field}>
                  <option value="">{location ? 'Any distance' : 'Enable location first'}</option>
                  {DISTANCE_OPTIONS.map(miles => <option key={miles} value={miles}>{miles} miles</option>)}
                </select>
              </label>
              <label className={label}>
                From date
                <input type="date" value={fromDate} aria-invalid={dateRangeInvalid || undefined} aria-describedby={dateRangeInvalid ? 'game-date-error' : undefined} onChange={e => setFromDate(e.target.value)} className={field} />
              </label>
              <label className={label}>
                To date
                <input type="date" value={toDate} aria-invalid={dateRangeInvalid || undefined} aria-describedby={dateRangeInvalid ? 'game-date-error' : undefined} onChange={e => setToDate(e.target.value)} className={field} />
              </label>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-6 text-sm text-white/80">
              <label className="flex min-h-11 cursor-pointer items-center gap-2">
                <input type="checkbox" checked={showCancelled} onChange={e => setShowCancelled(e.target.checked)} className="accent-[#d7fc83]" /> Show cancelled
              </label>
              <label className="flex min-h-11 cursor-pointer items-center gap-2">
                <input type="checkbox" checked={showPast} onChange={e => setShowPast(e.target.checked)} className="accent-[#d7fc83]" /> Show past
              </label>
            </div>
          </details>
          {dateRangeInvalid && <p id="game-date-error" role="alert" className="mt-2 text-sm text-rose-200">Choose an end date on or after the start date.</p>}
        </section>

        {loading ? (
          <div role="status" aria-busy="true" className="space-y-3"><span className="sr-only">Loading games</span>{[1, 2, 3].map(n => <div key={n} className="h-32 motion-safe:animate-pulse rounded-2xl bg-white/5" />)}</div>
        ) : failed ? (
          <div role="alert" className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-sm text-rose-200">
            <p>Sessions could not load. {error}</p>
            <button type="button" className="min-h-11 underline underline-offset-4" onClick={() => window.location.reload()}>Reload games</button>
          </div>
        ) : dateRangeInvalid ? null : games.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/20 p-10 text-center">
            <Search size={26} aria-hidden className="mx-auto mb-3 text-[#d7fc83]" />
            <p className="text-base font-bold">{hasFilters ? 'No games match these filters' : 'No upcoming games yet'}</p>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-white/75">{hasFilters ? 'Clear the filters to see more games, or plan a rally of your own.' : 'Create a rally and share the invite with your hitting partners.'}</p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {hasFilters && <button type="button" onClick={clearFilters} className={button}>Show all upcoming games</button>}
              <Link to="/rallies?create=1" className="inline-flex min-h-11 items-center rounded-xl bg-[#d7fc83] px-4 py-2 text-sm font-bold text-[#101a13]">Create a session</Link>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p role="status" className="text-sm text-white/75">{games.length} game{games.length === 1 ? '' : 's'} found</p>
            {games.map(game => (
              <article key={game.recordId} className="rounded-2xl border border-white/15 bg-[#141b1a]">
              <Link
                to={`/rallies?session=${encodeURIComponent(game.recordId)}`}
                className="block w-full rounded-2xl p-4 text-left hover:bg-white/5 focus-visible:outline-2"
              >
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <span className={`rounded-lg px-2.5 py-1 text-[11px] font-bold ${game.cancelled ? 'bg-rose-400/15 text-rose-200' : game.status === 'target-reached' ? 'bg-[#d7fc83]/15 text-[#d7fc83]' : 'bg-white/10 text-white/85'}`}>
                    {gameStatusLabel(game)}
                  </span>
                  <ChevronRight size={17} className="text-white/30" />
                </div>
                <h2 className="break-words text-lg font-semibold leading-snug tracking-tight">{game.session.title}</h2>
                <p className="mt-2 flex items-center gap-2 text-xs text-white/75"><CalendarDays size={13} aria-hidden className="shrink-0" />{formatSessionTime(game.session.startsAt)} · {game.session.level}</p>
                <p className="mt-2 flex items-center gap-2 text-xs text-white/75"><MapPin size={13} aria-hidden className="shrink-0" /><span className="min-w-0 break-words">{game.session.court}, {game.session.location}
                  {game.distanceMiles !== null && ` · ${formatDistanceMiles(game.distanceMiles)}`}</span>
                </p>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-3">
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-white/75"><Users size={14} className="text-[#d7fc83]" />{game.going} going / target {game.session.targetPlayers}{game.maybe > 0 ? ` · ${game.maybe} maybe` : ''}</span>
                  {queuedSessions.has(game.recordId) && !myConfirmedSessions.has(game.recordId) && !game.cancelled && !game.past
                    ? <span className="text-xs font-semibold text-[#d7fc83]">On the waitlist</span>
                    : game.isMine && <span className="text-xs font-semibold text-[#d7fc83]">You’re involved</span>}
                </div>
              </Link>
              <DiscoveryRsvp sessionId={game.recordId} action={waitlist.status === 'ready'
                ? discoveryAction(game, userId, myConfirmedSessions.has(game.recordId), queuedSessions.has(game.recordId))
                : null} />
              </article>
            ))}
          </div>
        )}

        <p className="text-xs leading-relaxed text-white/65">
          Distances are straight-line estimates for courts with known coordinates. Find Games uses your location on this page only.
        </p>
      </div>
    </div>
  )
}
