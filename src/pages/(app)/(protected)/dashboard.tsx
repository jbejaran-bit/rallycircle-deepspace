import { useMemo, useState } from 'react'
import { useAuth, useQuery, useUser } from 'deepspace'
import { Link } from 'react-router-dom'
import { ArrowRight, CalendarDays, MapPin, Plus } from 'lucide-react'
import { buildDashboard, filterAgenda, type DashboardFilter } from '@/lib/rally-dashboard'
import { formatSessionTime, type RallyRSVP, type RallySession, type RallyWaitlist } from '@/lib/rally'
import { resultStatus } from '@/lib/rally-score'

const filters: { id: DashboardFilter; label: string }[] = [
  { id: 'upcoming', label: 'Upcoming' }, { id: 'hosting', label: 'Hosting' },
  { id: 'participating', label: 'Participating' }, { id: 'waitlisted', label: 'Waitlisted' },
  { id: 'cancelled', label: 'Cancelled' }, { id: 'past', label: 'Past' },
]

const matchLabels = {
  'in-progress': 'In progress', proposed: 'Awaiting confirmation', confirmed: 'Partially confirmed',
  disputed: 'Disputed', final: 'Final',
}

const panel = 'rounded-2xl border border-white/15 bg-[#17251d] p-4 sm:p-6'
const button = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-bold focus-visible:outline-2 focus-visible:outline-offset-4'
const outline = `${button} border border-white/25 text-white hover:bg-white/10`

export default function DashboardPage() {
  const { userId } = useAuth()
  const { user } = useUser()
  const sessions = useQuery<RallySession>('sessions')
  const rsvps = useQuery<RallyRSVP>('rsvps', { where: { userId } })
  const waitlist = useQuery<RallyWaitlist>('waitlists', { where: { userId } })
  const [filter, setFilter] = useState<DashboardFilter>('upcoming')
  const [now] = useState(Date.now)
  const dashboard = useMemo(
    () => buildDashboard(sessions.records, rsvps.records.map(row => row.data), waitlist.records.map(row => row.data), userId ?? '', now),
    [sessions.records, rsvps.records, waitlist.records, userId, now],
  )
  const agenda = filterAgenda(dashboard.entries, filter)
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
          <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <section className={panel} aria-labelledby="agenda-title">
              <h2 id="agenda-title" className="text-xl font-bold">My sessions</h2>
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
                        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="break-all font-bold">{data.title}</h3><span className="text-sm text-[#d7fc83]">{cancelled ? 'Cancelled' : waiting ? 'Waitlisted' : hosting ? 'Hosting' : response === 'maybe' ? 'Tentative' : response === 'going' ? 'Going' : 'Match participant'}</span></div>
                        <p className="mt-2 flex items-center gap-2 text-sm text-white/75"><CalendarDays size={15} aria-hidden />{formatSessionTime(data.startsAt)}</p>
                        <p className="mt-1 flex items-center gap-2 text-sm text-white/75"><MapPin size={15} aria-hidden />{data.court} · {data.location}</p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className={panel} aria-labelledby="matches-title">
              <h2 id="matches-title" className="text-xl font-bold">My matches</h2>
              {dashboard.finalized > 0 && <p className="mt-2 text-sm text-white/75">{dashboard.wins} won · {dashboard.finalized} finalized</p>}
              {dashboard.matches.length === 0 ? <p className="mt-3 text-sm text-white/75">Matches appear here when a host adds you to a scoreboard.</p> : (
                <ul className="mt-3 divide-y divide-white/15">
                  {dashboard.matches.map(({ recordId, data, score, side }) => score && (
                    <li key={recordId}>
                      <Link to={`/rallies?session=${encodeURIComponent(recordId)}`} className="block rounded-lg py-3 focus-visible:outline-2">
                        <h3 className="break-all font-semibold">{data.title}</h3>
                        <p className="text-sm text-white/75">{matchLabels[resultStatus(score)]}{resultStatus(score) === 'final' && (score.winner === side ? ' · Won' : ' · Lost')}</p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  )
}
