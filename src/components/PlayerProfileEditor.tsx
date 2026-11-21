import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui'
import { getMatchHistory, getPlayerStats, updateProfile, type PlayerStatsResponse } from '@/lib/profile-actions'
import { PROFILE_FORMATS, PROFILE_LEVELS, validateProfileInput, type ProfileInput } from '@/lib/profile'
import type { MatchHistoryEntry, StatsFormat } from '@/lib/match-stats'

const initial: ProfileInput = {
  displayName: '', bio: '', formats: [], preferredArea: '', selfReportedLevel: 'Unrated', visibility: 'private',
}
const field = 'mt-1 block min-h-11 w-full rounded-lg border border-white/25 bg-[#101b14] px-3 py-2 focus-visible:outline-2'
type Statistics = NonNullable<PlayerStatsResponse['data']>['stats']

export function PlayerProfileEditor({ userId }: { userId: string }) {
  const [draft, setDraft] = useState<ProfileInput>(initial)
  const [stats, setStats] = useState<Statistics>()
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const inFlight = useRef(false)
  useEffect(() => {
    let current = true
    void getPlayerStats(userId).then(profile => {
      if (!current) return
      if (profile.data?.userId !== userId || !profile.data.stats) throw new Error('Profile records could not be read.')
      const saved = profile.data.profile
      setDraft(saved ? { ...saved, formats: Array.isArray(saved.formats) ? saved.formats : [] } : initial)
      setStats(profile.data.stats)
    }).catch(() => {
      if (current) setLoadError('Your player profile could not load.')
    }).finally(() => {
      if (current) setLoading(false)
    })
    return () => { current = false }
  }, [userId, attempt])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current) return
    setError('')
    setMessage('')
    const input = validateProfileInput(draft)
    if (!input.ok) {
      setError(input.error)
      return
    }
    inFlight.current = true
    setSaving(true)
    try {
      await updateProfile(input.data)
      setDraft(input.data)
      setMessage('Player profile saved.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Your profile could not be saved.')
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  return (
    <section aria-labelledby="player-profile-editor" className="space-y-4 rounded-2xl border border-white/15 bg-[#17251d] p-5">
      <h2 id="player-profile-editor" className="text-xl font-bold">Player profile</h2>
      {loading ? <p role="status">Loading player records…</p> : loadError ? (
        <>
          <p role="alert">{loadError}</p>
          <Button type="button" onClick={() => { setLoading(true); setLoadError(''); setAttempt(value => value + 1) }}>Retry</Button>
        </>
      ) : (
        <>
          <form className="space-y-4" onChange={() => { setMessage(''); setError('') }} onSubmit={event => void submit(event)}>
            <fieldset className="space-y-4" disabled={saving}>
              <label className="block">Display name<input className={field} autoComplete="nickname" required maxLength={40} value={draft.displayName} onChange={event => setDraft({ ...draft, displayName: event.target.value })} /></label>
              <label className="block">About your tennis<textarea className={field} maxLength={280} value={draft.bio} onChange={event => setDraft({ ...draft, bio: event.target.value })} /></label>
              <fieldset className="flex flex-wrap gap-4">
                <legend className="mb-2">Preferred formats</legend>
                {PROFILE_FORMATS.map(format => <label key={format} className="inline-flex min-h-11 items-center gap-2"><input type="checkbox" checked={draft.formats.includes(format)} onChange={event => setDraft({
                  ...draft, formats: event.target.checked ? [...draft.formats, format] : draft.formats.filter(value => value !== format),
                })} />{format}</label>)}
              </fieldset>
              <label className="block">General playing area<input className={field} placeholder="City or region" maxLength={100} value={draft.preferredArea} onChange={event => setDraft({ ...draft, preferredArea: event.target.value })} /></label>
              <label className="block">Self-reported level<select className={field} value={draft.selfReportedLevel} onChange={event => setDraft({ ...draft, selfReportedLevel: event.target.value as ProfileInput['selfReportedLevel'] })}>{PROFILE_LEVELS.map(level => <option key={level}>{level}</option>)}</select></label>
              <label className="block">Profile and results visibility<select className={field} value={draft.visibility} onChange={event => setDraft({ ...draft, visibility: event.target.value as ProfileInput['visibility'] })}><option value="private">Private profile</option><option value="public">Visible to signed-in players</option></select></label>
              <p className="text-sm text-white/75">This setting applies to profile and history views. Scores shown on shared rallies follow the rally’s access rules.</p>
              <Button type="submit">{saving ? 'Saving…' : 'Save player profile'}</Button>
            </fieldset>
            {error && <p role="alert" className="text-rose-200">{error}</p>}
            {message && <p role="status">{message}</p>}
          </form>

        </>
      )}
      <MatchHistory userId={userId} stats={stats} />
    </section>
  )
}

const HISTORY_PAGE_SIZE = 20
const HISTORY_MAX_SIZE = 50

function MatchHistory({ userId, stats }: { userId: string; stats: Statistics | undefined }) {
  const [history, setHistory] = useState<MatchHistoryEntry[]>()
  const [format, setFormat] = useState<StatsFormat | 'all'>('all')
  const [limit, setLimit] = useState(HISTORY_PAGE_SIZE)
  const [retry, setRetry] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let current = true
    void getMatchHistory(userId, limit).then(result => {
      if (!current) return
      if (result.data?.userId !== userId || !Array.isArray(result.data.entries)) {
        throw new Error('Your match history could not load.')
      }
      setHistory(result.data.entries)
    }).catch(cause => {
      if (current) setError(cause instanceof Error ? cause.message : 'Your match history could not load.')
    }).finally(() => {
      if (current) setLoading(false)
    })
    return () => { current = false }
  }, [userId, limit, retry])

  const visible = history?.filter(entry => format === 'all' || entry.format === format) ?? []

  function requestMore() {
    setLoading(true)
    setError('')
    setLimit(value => Math.min(value + HISTORY_PAGE_SIZE, HISTORY_MAX_SIZE))
  }

  return (
    <section aria-labelledby="player-history" className="space-y-4 border-t border-white/20 pt-5">
      <div>
        <h3 id="player-history" className="text-lg font-bold">Match history</h3>
        <p className="mt-1 text-sm text-white/75">Scores appear here after all required players confirm the result.</p>
      </div>
      {stats && <div className="grid gap-2 sm:grid-cols-2">
        {(['singles', 'doubles'] as const).map(value => (
          <div key={value} className="rounded-xl border border-white/15 p-3">
            <h4 className="font-semibold capitalize">{value}</h4>
            <p className="text-sm text-white/80">{stats[value].wins} wins · {stats[value].losses} losses</p>
          </div>
        ))}
      </div>}
      {Boolean(history?.length) && (
        <label className="block text-sm">
          Filter shown results
          <select className={field} value={format} onChange={event => setFormat(event.target.value as typeof format)}>
            <option value="all">All formats</option>
            <option value="singles">Singles</option>
            <option value="doubles">Doubles</option>
          </select>
        </label>
      )}
      {loading && <p role="status">{history ? 'Loading more matches…' : 'Loading match history…'}</p>}
      {error && <div>
        <p role="alert" className="text-rose-200">{error}</p>
        <Button className="mt-2" type="button" variant="outline" onClick={() => {
          setLoading(true)
          setError('')
          setRetry(value => value + 1)
        }}>Retry match history</Button>
      </div>}
      {visible.length > 0 && <ul className="divide-y divide-white/10">
        {visible.map(entry => <li key={entry.sessionId} className="py-2">
          <Link className="grid min-h-11 grid-cols-[1fr_auto] items-center gap-2 rounded-lg px-2 py-1 hover:bg-white/5 focus-visible:outline-2" to={`/rallies?session=${encodeURIComponent(entry.sessionId)}`}>
            <span className="min-w-0">
              <span className="block font-semibold capitalize text-[#d7fc83]">{entry.won ? 'Win' : 'Loss'} · {entry.format}</span>
              <span className="block break-words text-sm tabular-nums">{entry.sets.map(set => set.join('–')).join(', ')}</span>
            </span>
            <time className="text-end text-xs text-white/75" dateTime={entry.finalizedAt}>{formatResultDate(entry.finalizedAt)}</time>
          </Link>
        </li>)}
      </ul>}
      {!loading && !error && history?.length === 0 && <p className="text-sm text-white/75">No confirmed matches yet.</p>}
      {!loading && !error && Boolean(history?.length) && visible.length === 0 && <p className="text-sm text-white/75">No {format} results in the matches shown.</p>}
      {!error && history?.length === limit && limit < HISTORY_MAX_SIZE && (
        <Button variant="outline" type="button" disabled={loading} onClick={requestMore}>Load older matches</Button>
      )}
    </section>
  )
}

function formatResultDate(value: string) {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Date unavailable'
}
