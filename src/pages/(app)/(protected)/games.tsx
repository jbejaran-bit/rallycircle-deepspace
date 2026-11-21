import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth, useQuery } from 'deepspace'
import { CalendarDays, ChevronRight, LocateFixed, MapPin, Sparkles, Users } from 'lucide-react'
import { courts as pittsburghCourts } from '@/lib/courts'
import { DiscoveryRsvp } from '@/components/DiscoveryRsvp'
import { discoveryAction, filterGames, gameStatusLabel, DEFAULT_GAME_RADIUS_MILES, type GameFormat, type KnownCourtLocation } from '@/lib/find-games'
import { formatDistanceMiles, type LatLng } from '@/lib/geo'
import { requestOneShotLocation } from '@/lib/location'
import { formatSessionTime, type Level, type RallyRSVP, type RallySession, type RallyWaitlist } from '@/lib/rally'

const LEVELS: (Level | 'Any level')[] = ['Any level', 'Beginner', 'Intermediate', 'Advanced']
const DISTANCE_OPTIONS: (number | null)[] = [null, 2, 5, 10, 25]

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
  const { records: sessions, status: sessionStatus, error: sessionsError } = useQuery<RallySession>('sessions', { orderBy: 'startsAt', orderDir: 'asc' })
  const { records: rsvps, status: rsvpStatus, error: rsvpError } = useQuery<RallyRSVP>('rsvps')

  const waitlist = useQuery<RallyWaitlist>('waitlists', { where: { userId } })
  const myConfirmedSessions = useMemo(() => new Set(rsvps.filter(row => row.data.userId === userId && row.data.status === 'going').map(row => row.data.sessionId)), [rsvps, userId])
  const queuedSessions = useMemo(() => new Set(waitlist.records.map(row => row.data.sessionId)), [waitlist.records])
  const [knownCourts] = useState<KnownCourtLocation[]>(() => [...pittsburghCourts.map(court => ({ ...court, locality: 'Pittsburgh' })), ...loadDiscoveredCourts()])
  const [availability, setAvailability] = useState<'any' | 'spots' | 'waitlist'>('any')
  const [area, setArea] = useState('')
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

  const games = useMemo(() => {
    if (sessionStatus !== 'ready' || rsvpStatus !== 'ready') return []
    return filterGames(
      sessions,
      rsvps.map(r => r.data),
      {
        area,
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
  }, [sessions, rsvps, sessionStatus, rsvpStatus, area, level, format, fromDate, toDate, maxDistance, showCancelled, showPast, availability, userId, location, knownCourts])

  async function locate() {
    setLocating(true)
    setLocationStatus('')
    try {
      const point = await requestOneShotLocation()
      setLocation(point)
      setMaxDistance(DEFAULT_GAME_RADIUS_MILES)
      setLocationStatus(`Showing games within ${DEFAULT_GAME_RADIUS_MILES} miles of you (straight-line distance). Only sessions at courts with known coordinates can be distance-filtered.`)
    } catch (cause) {
      setLocationStatus(cause instanceof Error ? cause.message : 'Could not get your location.')
    } finally {
      setLocating(false)
    }
  }

  const loading = sessionStatus === 'loading' || rsvpStatus === 'loading'
  const failed = sessionStatus === 'error' || rsvpStatus === 'error'
  const error = sessionStatus === 'error' ? sessionsError : rsvpError

  return (
    <div className="min-h-screen bg-[#0b110f] text-white">
      <div className="mx-auto max-w-7xl space-y-6 px-4 py-10 sm:px-8">
        <header>
          <h1 className="text-4xl font-black tracking-tight">Find games near me</h1>
          <p className="mt-2 max-w-2xl text-white/70">
            Browse upcoming community sessions. Open a rally to RSVP or join its waitlist.
            Distances are straight-line and only shown where a court has known coordinates; sessions with a text-only location are never geocoded.
          </p>
        </header>

        <section aria-label="Filters" className="rounded-2xl border border-white/15 bg-[#141b1a] p-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block text-xs font-medium text-white/75">
              Area or court
              <input value={area} onChange={e => setArea(e.target.value)} placeholder="e.g. Schenley, Oakland" className="mt-1.5 w-full rounded-xl border border-white/15 bg-[#0e1513] px-3.5 py-3 text-sm text-white outline-none placeholder:text-white/35 focus:border-[#d7fc83]" />
            </label>
            <label className="block text-xs font-medium text-white/75">
              Skill level
              <select value={level} onChange={e => setLevel(e.target.value as Level | 'Any level')} className="mt-1.5 w-full rounded-xl border border-white/15 bg-[#0e1513] px-3.5 py-3 text-sm text-white outline-none">
                {LEVELS.map(item => <option key={item}>{item}</option>)}
              </select>
            </label>
            <label className="block text-xs font-medium text-white/75">
              Format
              <select value={format} onChange={e => setFormat(e.target.value as GameFormat)} className="mt-1.5 w-full rounded-xl border border-white/15 bg-[#0e1513] px-3.5 py-3 text-sm text-white outline-none">
                <option value="any">Any format</option>
                <option value="singles">Singles</option>
                <option value="doubles">Doubles</option>
                <option value="practice">Practice</option>
              </select>
            </label>
            <label className="block text-xs font-medium text-white/75">
              Places
              <select value={availability} onChange={e => setAvailability(e.target.value as typeof availability)} className="mt-1.5 min-h-11 w-full rounded-xl border border-white/15 bg-[#0e1513] px-3.5">
                <option value="any">Any availability</option>
                <option value="spots">Places available</option>
                <option value="waitlist">Full with waitlist</option>
              </select>
            </label>
            <label className="block text-xs font-medium text-white/75">
              Within distance
              <select
                value={maxDistance === null ? '' : String(maxDistance)}
                disabled={!location}
                onChange={e => setMaxDistance(e.target.value === '' ? null : Number(e.target.value))}
                className="mt-1.5 w-full rounded-xl border border-white/15 bg-[#0e1513] px-3.5 py-3 text-sm text-white outline-none disabled:opacity-50"
              >
                <option value="">Any distance</option>
                {DISTANCE_OPTIONS.filter((option): option is number => option !== null).map(miles => (
                  <option key={miles} value={miles}>{miles} miles</option>
                ))}
              </select>
            </label>
            <label className="block text-xs font-medium text-white/75">
              From date
              <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="mt-1.5 w-full rounded-xl border border-white/15 bg-[#0e1513] px-3.5 py-3 text-sm text-white outline-none" />
            </label>
            <label className="block text-xs font-medium text-white/75">
              To date
              <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="mt-1.5 w-full rounded-xl border border-white/15 bg-[#0e1513] px-3.5 py-3 text-sm text-white outline-none" />
            </label>
            <div className="flex items-end gap-4 pb-1 text-sm text-white/75">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={showCancelled} onChange={e => setShowCancelled(e.target.checked)} /> Show cancelled
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={showPast} onChange={e => setShowPast(e.target.checked)} /> Show past
              </label>
            </div>
            <div className="flex items-end">
              <button type="button" disabled={locating} onClick={() => void locate()} className="inline-flex items-center gap-2 rounded-xl border border-white/20 px-4 py-3 text-sm font-semibold disabled:opacity-50">
                <LocateFixed size={16} /> {locating ? 'Finding location…' : location ? 'Update my location' : 'Use my location'}
              </button>
            </div>
          </div>
          {locationStatus && <p role="status" className="mt-4 text-sm text-white/65">{locationStatus}</p>}
        </section>

        {loading ? (
          <div role="status" aria-busy="true" className="space-y-3"><span className="sr-only">Loading games</span>{[1, 2, 3].map(n => <div key={n} className="h-32 motion-safe:animate-pulse rounded-2xl bg-white/5" />)}</div>
        ) : failed ? (
          <div role="alert" className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-sm text-rose-200">
            <p>Sessions could not load. {error}</p>
            <button type="button" className="min-h-11 underline underline-offset-4" onClick={() => window.location.reload()}>Reload games</button>
          </div>
        ) : games.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/20 p-10 text-center">
            <Sparkles size={28} className="mx-auto mb-3 text-[#d7fc83]" />
            <p className="text-sm font-bold">No games match these filters</p>
            <p className="mt-2 text-xs leading-relaxed text-white/50">Try widening the date range, clearing the area, or removing the distance limit. You can also create a session of your own.</p>
            <Link to="/rallies?create=1" className="mt-4 inline-block rounded-xl bg-[#d7fc83] px-4 py-3 text-sm font-bold text-[#101a13]">Create a session</Link>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-white/55">{games.length} game{games.length === 1 ? '' : 's'} found</p>
            {games.map(game => (
              <article key={game.recordId} className="rounded-2xl border border-white/15 bg-[#141b1a]">
              <Link
                to={`/rallies?session=${encodeURIComponent(game.recordId)}`}
                className="block w-full rounded-2xl p-4 text-left hover:bg-white/5 focus-visible:outline-2"
              >
                <div className="mb-3 flex items-center justify-between">
                  <span className={`rounded-lg px-2.5 py-1 text-[11px] font-bold ${game.cancelled ? 'bg-rose-400/15 text-rose-200' : game.status === 'target-reached' ? 'bg-[#d7fc83]/15 text-[#d7fc83]' : 'bg-white/10 text-white/85'}`}>
                    {gameStatusLabel(game)}
                  </span>
                  <ChevronRight size={17} className="text-white/30" />
                </div>
                <h2 className="text-lg font-extrabold tracking-tight">{game.session.title}</h2>
                <p className="mt-2 flex items-center gap-2 text-xs text-white/60"><CalendarDays size={13} />{formatSessionTime(game.session.startsAt)} · {game.session.level}</p>
                <p className="mt-2 flex items-center gap-2 text-xs text-white/60"><MapPin size={13} />{game.session.court}, {game.session.location}
                  {game.distanceMiles !== null && <span>· {formatDistanceMiles(game.distanceMiles)}</span>}
                </p>
                <div className="mt-4 flex items-center justify-between border-t border-white/10 pt-3">
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-white/75"><Users size={14} className="text-[#d7fc83]" />{game.going} going / target {game.session.targetPlayers}{game.maybe > 0 ? ` · ${game.maybe} maybe` : ''}</span>
                  <span className="text-[11px] font-bold text-[#d7fc83]">{!game.cancelled && queuedSessions.has(game.recordId) && !myConfirmedSessions.has(game.recordId) ? 'On your waitlist' : game.cancelled ? '' : game.isMine ? 'You’re involved' : game.status === 'full' ? 'Waitlist available' : 'Open to join'}</span>
                </div>
              </Link>
              <DiscoveryRsvp sessionId={game.recordId} action={waitlist.status === 'ready'
                ? discoveryAction(game, userId, myConfirmedSessions.has(game.recordId), queuedSessions.has(game.recordId))
                : null} />
              </article>
            ))}
          </div>
        )}

        <p className="text-xs text-white/40">
          Only public sessions visible to signed-in members are listed. Your location, when used, stays on this page for the distance filter and is never saved or shared.
        </p>
      </div>
    </div>
  )
}
