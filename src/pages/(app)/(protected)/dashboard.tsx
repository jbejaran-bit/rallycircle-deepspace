import { useEffect, useMemo, useState } from 'react'
import { useAuth, useQuery, useUser, useUserLookup } from 'deepspace'
import { Link } from 'react-router-dom'
import { ArrowRight, CalendarDays, ChevronLeft, ChevronRight, ClipboardCheck, Clock3, MapPin, Plus } from 'lucide-react'
import { agendaWeek, buildDashboard, filterAgenda, groupAgendaByDay, type DashboardFilter } from '@/lib/rally-dashboard'
import { formatSessionTime, type RallyRSVP, type RallySession, type RallyWaitlist } from '@/lib/rally'
import { resultStatus } from '@/lib/rally-score'

const filters: { id: DashboardFilter; label: string }[] = [
  { id: 'upcoming', label: 'Upcoming' }, { id: 'hosting', label: 'Hosting' },
  { id: 'participating', label: 'Participating' }, { id: 'waitlisted', label: 'Waitlisted' },
  { id: 'cancelled', label: 'Cancelled' }, { id: 'past', label: 'Past' },
]

const emptyAgenda = {
  upcoming: { message: 'You have no upcoming sessions.', label: 'Find a game', to: '/games' },
  hosting: { message: 'You haven’t hosted a rally yet.', label: 'Create a rally', to: '/rallies?create=1' },
  participating: { message: 'Your RSVPs will appear here.', label: 'Find a game', to: '/games' },
  waitlisted: { message: 'You’re not on any upcoming waitlists.', label: 'Browse games', to: '/games' },
  cancelled: { message: 'You have no cancelled sessions.' },
  past: { message: 'Completed session times will appear here.' },
} satisfies Record<DashboardFilter, { message: string; label?: string; to?: string }>

const rallyLink = (recordId: string) => '/rallies?' + new URLSearchParams({ session: recordId })

const matchLabels = {
  'in-progress': 'In progress', proposed: 'Awaiting confirmation', confirmed: 'Partially confirmed',
  disputed: 'Disputed', corrected: 'Corrected · awaiting confirmation', final: 'Final',
}

const panel = 'min-w-0 rounded-2xl border border-white/10 bg-[#141b1a] p-5 sm:p-6'
const button = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d7fc83]'
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
      confirmedRsvps.status === 'ready' && waitlist.status === 'ready' ? confirmedRsvps.records.map(row => row.data) : null,
    ),
    [sessions.records, rsvps.records, waitlist.records, userId, now, confirmedRsvps.records, confirmedRsvps.status, waitlist.status],
  )
  const agenda = filterAgenda(dashboard.entries, filter)
  const days = view === 'calendar' ? agendaWeek(new Date(now), week, dashboard.entries) : []
  const statuses = [sessions.status, rsvps.status]
  const failed = statuses.includes('error')
  const ready = statuses.every(status => status === 'ready') && waitlist.status !== 'loading'
  const waitlistFailed = waitlist.status === 'error'
  const next = dashboard.nextRally
  const empty: { message: string; label?: string; to?: string } = emptyAgenda[filter]

  return (
    <div className="min-h-full bg-[#0b110f] text-white">
      <div className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-8 lg:py-10">
        <header className="flex flex-wrap items-end justify-between gap-5 pb-1">
          <div className="min-w-0">
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#d7fc83]">Your tennis week</p>
            <h1 className="text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">Your dashboard</h1>
            {user?.name && <p className="mt-3 break-words text-sm text-white/75">Welcome, {user.name}.</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            <Link to="/notifications" className={outline}>Notifications</Link>
            <Link to="/series" className={outline}>Recurring rallies</Link>
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
          <section aria-labelledby="next-rally-title" className="overflow-hidden rounded-2xl border border-[#d7fc83]/30 bg-[#1b2a21] text-white">
            <div className="grid gap-5 p-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end sm:p-6">
              <div className="min-w-0">
                <h2 id="next-rally-title" className="flex items-center gap-2 text-sm font-semibold text-[#d7fc83]">
                  {next?.inSession ? <Clock3 size={16} aria-hidden /> : <CalendarDays size={16} aria-hidden />}
                  {next?.inSession ? 'Scheduled now' : 'Your next rally'}
                </h2>
                {next ? (
                  <>
                    <p className="mt-3 break-words text-2xl font-semibold leading-tight tracking-tight">{next.data.title}</p>
                    <p className="mt-3 break-words text-sm leading-relaxed text-white/75">
                      <time dateTime={next.data.startsAt}>{formatSessionTime(next.data.startsAt)}</time> · {next.data.court} · {next.data.location}
                    </p>
                    <p className="mt-3 text-xs font-medium text-white/75">{next.hosting ? 'You’re hosting' : 'You’re going'}</p>
                  </>
                ) : <p className="mt-2">Host a rally or confirm an RSVP to see your next session here.</p>}
              </div>
              <Link className={`${outline} sm:justify-self-end`} to={next ? rallyLink(next.recordId) : '/games'}>
                {next ? 'Open rally' : 'Browse games'} <ArrowRight size={16} aria-hidden />
              </Link>
            </div>
          </section>
          {dashboard.awaitingResponse.length > 0 && (
            <section aria-labelledby="confirm-result-title" className={panel}>
              <h2 id="confirm-result-title" className="flex items-center gap-2 text-lg font-bold">
                <ClipboardCheck size={20} className="shrink-0 text-[#d7fc83]" aria-hidden /> Results to review
              </h2>
              <ul className="mt-2 divide-y divide-white/15">
                {dashboard.awaitingResponse.map(({ recordId, data }) => (
                  <li key={recordId}>
                    <Link className="flex min-h-11 items-center justify-between gap-3 rounded-md py-2 text-sm font-semibold text-[#d7fc83] hover:underline focus-visible:outline-2" to={rallyLink(recordId) + '#rally-match'}>
                      <span className="min-w-0 break-words">{data.title}</span>
                      <span className="flex shrink-0 items-center gap-2">Review <ArrowRight size={16} aria-hidden /></span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <section className={panel} aria-labelledby="agenda-title">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 id="agenda-title" className="text-xl font-bold">My sessions</h2>
                <div className="flex gap-2" role="group" aria-label="Schedule view">
                  <button type="button" className={`${outline} aria-pressed:border-[#d7fc83] aria-pressed:bg-[#d7fc83]/15`} aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button>
                  <button type="button" className={`${outline} aria-pressed:border-[#d7fc83] aria-pressed:bg-[#d7fc83]/15`} aria-pressed={view === 'calendar'} onClick={() => setView('calendar')}>Week</button>
                </div>
              </div>
              {waitlistFailed && <p role="alert" className="mt-3 text-sm text-white/75">Waitlist status is unavailable. Your other sessions are still shown.</p>}
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
                                <Link className="block min-h-11 rounded-md py-2 text-sm text-[#d7fc83] hover:underline focus-visible:outline-2" to={rallyLink(recordId)}>
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
                  <p className="text-white/75">{filter === 'waitlisted' && waitlistFailed ? 'Try opening a rally to check your response.' : empty.message}</p>
                  {(filter !== 'waitlisted' || !waitlistFailed) && empty.to && <Link to={empty.to} className={`${outline} mt-3`}>{empty.label} <ArrowRight size={16} aria-hidden /></Link>}
                </div>
              ) : (
                <div className="mt-5 space-y-5">
                  {groupAgendaByDay(agenda).map(({ day, entries }) => (
                    <div key={day ?? 'unscheduled'}>
                      <h3 className="border-b border-white/15 pb-2 text-sm font-semibold text-white/75">
                        {day === null ? 'Date unavailable' : new Date(day).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
                      </h3>
                      <ul className="divide-y divide-white/15">
                        {entries.map(({ recordId, data, hosting, response, waiting, cancelled, scheduled, inSession }) => (
                          <li key={recordId}>
                            <Link to={rallyLink(recordId)} className="block rounded-lg py-4 focus-visible:outline-2">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <h4 className="min-w-0 break-words font-bold">{data.title}</h4>
                                <span className="text-sm text-[#d7fc83]">{cancelled ? 'Cancelled' : waiting ? 'Waitlisted' : hosting ? 'Hosting' : response === 'maybe' ? 'Tentative' : response === 'going' ? 'Going' : 'Match participant'}</span>
                              </div>
                              {scheduled && (
                                <p className="mt-2 flex items-center gap-2 text-sm text-white/75">
                                  <CalendarDays size={15} className="shrink-0" aria-hidden />
                                  <time dateTime={data.startsAt}>{new Date(data.startsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>
                                  {inSession && !cancelled && <span>· Scheduled now</span>}
                                </p>
                              )}
                              <p className="mt-1 flex items-start gap-2 text-sm text-white/75">
                                <MapPin size={15} className="mt-0.5 shrink-0" aria-hidden />
                                <span className="min-w-0 break-words">{data.court} · {data.location}</span>
                              </p>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
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
                      <Link to={rallyLink(recordId) + '#rally-match'} className="block rounded-lg py-3 focus-visible:outline-2">
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
            {waitlistFailed || confirmedRsvps.status === 'error' ? (
              <p role="alert" className="mt-2 text-sm text-white/75">Player openings could not load. You can still browse all games.</p>
            ) : confirmedRsvps.status === 'loading' ? (
              <p role="status" className="mt-2 text-sm text-white/75">Checking community attendance…</p>
            ) : dashboard.gamesNeedingPlayers.length ? (
              <ul className="mt-3 divide-y divide-white/15">
                {dashboard.gamesNeedingPlayers.map(({ recordId, data, needed }) => (
                  <li key={recordId}>
                    <Link className="block rounded-md py-3 focus-visible:outline-2" to={rallyLink(recordId)}>
                      <span className="block break-words font-bold">{data.title}</span>
                      <span className="break-words text-sm text-white/75"><time dateTime={data.startsAt}>{formatSessionTime(data.startsAt)}</time> · {data.court} · {needed} {needed === 1 ? 'player' : 'players'} to target</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : <p className="mt-2 text-sm text-white/75">No upcoming games are below their player target.</p>}
            <Link className={`${outline} mt-3`} to="/games">Explore all games <ArrowRight size={16} aria-hidden /></Link>
          </section>
          </>
        )}
      </div>
    </div>
  )
}
