import { useEffect, useMemo, useState } from 'react'
import { useAuth, useQuery, useUser, useUserLookup } from 'deepspace'
import { Link } from 'react-router-dom'
import { ArrowRight, CalendarDays, ChevronLeft, ChevronRight, MapPin, Plus } from 'lucide-react'
import { agendaWeek, buildDashboard, filterAgenda, type DashboardFilter } from '@/lib/rally-dashboard'
import { formatSessionTime, type RallyRSVP, type RallySession, type RallyWaitlist } from '@/lib/rally'
import { resultStatus } from '@/lib/rally-score'

const filters: { id: DashboardFilter; label: string }[] = [
  { id: 'upcoming', label: 'Upcoming' }, { id: 'hosting', label: 'Hosting' },
  { id: 'participating', label: 'Participating' }, { id: 'waitlisted', label: 'Waitlisted' },
  { id: 'cancelled', label: 'Cancelled' }, { id: 'past', label: 'Past' },
]

const matchLabels = {
  'in-progress': 'In progress', proposed: 'Awaiting confirmation', confirmed: 'Partially confirmed',
  disputed: 'Disputed', corrected: 'Corrected · awaiting confirmation', final: 'Final',
}

const panel = 'rounded-2xl border border-white/15 bg-[#17251d] p-4 sm:p-6'
const button = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-bold focus-visible:outline-2 focus-visible:outline-offset-4'
const outline = `${button} border border-white/25 text-white hover:bg-white/10`

export default function DashboardPage() {
  const { userId } = useAuth()
  const { user } = useUser()
  const { getName } = useUserLookup()
  const sessions = useQuery<RallySession>('sessions')
  const rsvps = useQuery<RallyRSVP>('rsvps', { where: { userId } })
  const confirmedRsvps = useQuery<RallyRSVP>('rsvps', { where: { status: 'going' } })
  const waitlist = useQuery<RallyWaitlist>('waitlists', { where: { userId } })
  const [filter, setFilter] = useState<DashboardFilter>('upcoming')
  const [now, setNow] = useState(Date.now)
  const [week, setWeek] = useState(0)
  const [view, setView] = useState<'list' | 'calendar'>('list')
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  const dashboard = useMemo(
    () => buildDashboard(
      sessions.records,
      rsvps.records.map(row => row.data),
      waitlist.records.map(row => row.data),
      userId ?? '',
      now,
      confirmedRsvps.status === 'ready' ? confirmedRsvps.records.map(row => row.data) : null,
    ),
    [sessions.records, rsvps.records, waitlist.records, userId, now, confirmedRsvps.records, confirmedRsvps.status],
  )
  const agenda = filterAgenda(dashboard.entries, filter)
  const days = view === 'calendar' ? agendaWeek(new Date(now), week, dashboard.entries) : []
  const statuses = [sessions.status, rsvps.status, waitlist.status]
  const failed = statuses.includes('error')
  const ready = statuses.every(status => status === 'ready')

  return (
    <div className="min-h-full bg-[#101b14] text-white">
      <div className="mx-auto max-w-6xl space-y-8 px-4 py-8 sm:px-7 lg:py-12">
        <header className="flex flex-wrap items-end justify-between gap-5 border-b border-white/15 pb-6">
          <div>
            <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Your dashboard</h1>
            {user?.name && <p className="mt-2 text-white/75">Welcome, {user.name}.</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            <Link to="/games" className={outline}>Find a game</Link>
            <Link to="/rallies?create=1" className={`${button} bg-[#d7fc83] text-[#152015] hover:bg-[#ecffb0]`}><Plus size={16} aria-hidden /> Create a rally</Link>
          </div>
        </header>
        {failed ? (
          <div role="alert" className={panel}>
            <p>Your latest activity could not be loaded.</p>
            <button className={`${outline} mt-3`} type="button" onClick={() => window.location.reload()}>Reload dashboard</button>
          </div>
        ) : !ready ? <p role="status" className={panel}>Loading your rallies and matches…</p> : (
          <>
          <section aria-labelledby="next-rally-title" className="rounded-2xl border border-[#d7fc83]/40 bg-[#d7fc83] p-5 text-[#152015] sm:p-6">
            <h2 id="next-rally-title" className="text-sm font-bold">Your next rally</h2>
            {dashboard.nextRally ? (
              <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-2xl font-bold">{dashboard.nextRally.data.title}</p>
                  <p className="mt-1 text-sm"><time dateTime={dashboard.nextRally.data.startsAt}>{formatSessionTime(dashboard.nextRally.data.startsAt)}</time> · {dashboard.nextRally.data.court}</p>
                </div>
                <Link className={`${button} bg-[#152015] text-white`} to={`/rallies?session=${encodeURIComponent(dashboard.nextRally.recordId)}`}>Open rally <ArrowRight size={16} aria-hidden /></Link>
              </div>
            ) : (
              <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
                <p>Host a rally or confirm an RSVP to see your next session here.</p>
                <Link className={`${button} bg-[#152015] text-white`} to="/games">Browse games <ArrowRight size={16} aria-hidden /></Link>
              </div>
            )}
          </section>
          <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <section className={panel} aria-labelledby="agenda-title">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 id="agenda-title" className="text-xl font-bold">My sessions</h2>
                <div className="flex gap-2" role="group" aria-label="Schedule view">
                  <button type="button" className={outline} aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button>
                  <button type="button" className={outline} aria-pressed={view === 'calendar'} onClick={() => setView('calendar')}>Week</button>
                </div>
              </div>
              {view === 'calendar' ? (
                <div className="mt-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" className={outline} aria-label="Previous week" onClick={() => setWeek(value => value - 1)}><ChevronLeft size={17} aria-hidden /></button>
                    <button type="button" className={outline} onClick={() => setWeek(0)}>This week</button>
                    <button type="button" className={outline} aria-label="Next week" onClick={() => setWeek(value => value + 1)}><ChevronRight size={17} aria-hidden /></button>
                  </div>
                  <p className="mt-3 text-sm text-white/75" role="status">Week of {days[0]?.date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}</p>
                  <ol className="mt-2 divide-y divide-white/15">
                    {days.map(day => (
                      <li key={day.date.getTime()} className="py-3">
                        <h3 className="text-sm font-bold">{day.date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</h3>
                        {day.entries.length === 0 ? <p className="mt-1 text-sm text-white/70">No sessions</p> : (
                          <ul className="mt-1 space-y-1">
                            {day.entries.map(({ recordId, data, cancelled }) => (
                              <li key={recordId}>
                                <Link className="block min-h-11 rounded-md py-2 text-sm text-[#d7fc83] hover:underline focus-visible:outline-2" to={`/rallies?session=${encodeURIComponent(recordId)}`}>
                                  <span className="break-words font-semibold">{data.title}</span> · <time dateTime={data.startsAt}>{new Date(data.startsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>
                                  {cancelled && ' · Cancelled'}
                                </Link>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              ) : <>
              <div className="mt-4 flex flex-wrap gap-2" aria-label="Filter sessions" role="group">
                {filters.map(({ id, label }) => (
                  <button type="button" key={id} aria-pressed={filter === id} onClick={() => setFilter(id)} className={`${outline} aria-pressed:border-[#d7fc83] aria-pressed:bg-[#d7fc83]/15`}>{label}</button>
                ))}
              </div>
              {agenda.length === 0 ? (
                <div className="mt-5 border-t border-white/15 pt-5">
                  <p className="text-white/75">No sessions in this view.</p>
                  <Link to="/courts" className={`${outline} mt-3`}>Explore courts <ArrowRight size={16} aria-hidden /></Link>
                </div>
              ) : (
                <ul className="mt-4 divide-y divide-white/15">
                  {agenda.map(({ recordId, data, hosting, response, waiting, cancelled }) => (
                    <li key={recordId}>
                      <Link to={`/rallies?session=${encodeURIComponent(recordId)}`} className="block rounded-lg py-4 focus-visible:outline-2">
                        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="break-words font-bold">{data.title}</h3><span className="text-sm text-[#d7fc83]">{cancelled ? 'Cancelled' : waiting ? 'Waitlisted' : hosting ? 'Hosting' : response === 'maybe' ? 'Tentative' : response === 'going' ? 'Going' : 'Match participant'}</span></div>
                        <p className="mt-2 flex items-center gap-2 text-sm text-white/75"><CalendarDays size={15} aria-hidden />{formatSessionTime(data.startsAt)}</p>
                        <p className="mt-1 flex items-center gap-2 text-sm text-white/75"><MapPin size={15} aria-hidden />{data.court} · {data.location}</p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              </>}
            </section>
            <section className={panel} aria-labelledby="matches-title">
              <h2 id="matches-title" className="text-xl font-bold">My matches</h2>
              {dashboard.finalized > 0 && <p className="mt-2 text-sm text-white/75">{dashboard.wins} won · {dashboard.finalized} finalized</p>}
              {dashboard.matches.length === 0 ? <p className="mt-3 text-sm text-white/75">Matches appear here when a host adds you to a scoreboard.</p> : (
                <ul className="mt-3 divide-y divide-white/15">
                  {dashboard.matches.map(({ recordId, data, score, side }) => score && (side === 0 || side === 1) && (
                    <li key={recordId}>
                      <Link to={`/rallies?session=${encodeURIComponent(recordId)}`} className="block rounded-lg py-3 focus-visible:outline-2">
                        <h3 className="break-words font-semibold">{data.title}</h3>
                        <p className="text-sm text-white/75">{matchLabels[resultStatus(score)]}{resultStatus(score) === 'final' && (score.winner === side ? ' · Won' : ' · Lost')}</p>
                        <p className="mt-1 text-sm text-white/75">{score.teams[side === 0 ? 1 : 0].map(id => getName(id) ?? 'Player').join(' / ')}</p>
                        {score.sets.length > 0 && <p className="text-sm tabular-nums text-white/75" aria-label="Completed sets">{score.sets.map(set => `${set[side]}–${set[side === 0 ? 1 : 0]}`).join(', ')}</p>}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
          <section className={panel} aria-labelledby="open-games-title">
            <h2 id="open-games-title" className="text-xl font-bold">Games needing players</h2>
            {confirmedRsvps.status === 'error' ? (
              <p role="alert" className="mt-2 text-sm text-white/75">Community attendance could not load. Your personal schedule is still available.</p>
            ) : confirmedRsvps.status === 'loading' ? (
              <p role="status" className="mt-2 text-sm text-white/75">Checking community attendance…</p>
            ) : dashboard.gamesNeedingPlayers.length ? (
              <ul className="mt-3 divide-y divide-white/15">
                {dashboard.gamesNeedingPlayers.map(({ recordId, data, needed }) => (
                  <li key={recordId}>
                    <Link className="block rounded-md py-3 focus-visible:outline-2" to={`/rallies?session=${encodeURIComponent(recordId)}`}>
                      <span className="block font-bold">{data.title}</span>
                      <span className="text-sm text-white/75"><time dateTime={data.startsAt}>{formatSessionTime(data.startsAt)}</time> · {data.court} · {needed} {needed === 1 ? 'player' : 'players'} to target</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : <p className="mt-2 text-sm text-white/75">No upcoming games need more players right now.</p>}
            <Link className={`${outline} mt-3`} to="/games">Explore all games <ArrowRight size={16} aria-hidden /></Link>
          </section>
          </>
        )}
      </div>
    </div>
  )
}
