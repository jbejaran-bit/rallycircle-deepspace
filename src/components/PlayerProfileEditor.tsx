import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui'
import { getMatchHistory, getPlayerStats, updateProfile, type PlayerStatsResponse } from '@/lib/profile-actions'
import { PROFILE_FORMATS, PROFILE_LEVELS, validateProfileInput, type ProfileInput } from '@/lib/profile'
import type { MatchHistoryEntry } from '@/lib/match-stats'

const initial: ProfileInput = {
  displayName: '', bio: '', formats: [], preferredArea: '', selfReportedLevel: 'Unrated', visibility: 'private',
}
const field = 'mt-1 block min-h-11 w-full rounded-lg border border-white/25 bg-[#101b14] px-3 py-2 focus-visible:outline-2'
type Statistics = NonNullable<PlayerStatsResponse['data']>['stats']

export function PlayerProfileEditor({ userId }: { userId: string }) {
  const [draft, setDraft] = useState<ProfileInput>(initial)
  const [stats, setStats] = useState<Statistics>()
  const [history, setHistory] = useState<MatchHistoryEntry[]>()
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const inFlight = useRef(false)
  useEffect(() => {
    let current = true
    void Promise.all([getPlayerStats(userId), getMatchHistory(userId)]).then(([profile, results]) => {
      if (!current) return
      if (!profile.data?.stats || !Array.isArray(results.data?.entries)) throw new Error('Profile records could not be read.')
      const saved = profile.data.profile
      setDraft(saved ? { ...saved, formats: Array.isArray(saved.formats) ? saved.formats : [] } : initial)
      setStats(profile.data.stats)
      setHistory(results.data.entries)
    }).catch(() => {
      if (current) setError('Your profile and history could not load.')
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
      <h2 id="player-profile-editor" className="text-xl font-bold">Player profile and results</h2>
      {loading ? <p role="status">Loading player records…</p> : history === undefined ? (
        <>
          <p role="alert">{error}</p>
          <Button type="button" onClick={() => { setLoading(true); setError(''); setAttempt(value => value + 1) }}>Retry</Button>
        </>
      ) : (
        <>
          <form className="space-y-4" onSubmit={event => void submit(event)}>
            <fieldset className="space-y-4" disabled={saving}>
              <label className="block">Display name<input className={field} required maxLength={40} value={draft.displayName} onChange={event => setDraft({ ...draft, displayName: event.target.value })} /></label>
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
          <div className="space-y-3 border-t border-white/20 pt-4">
            <h3 className="font-bold">Finalized match records</h3>
            {stats && (['singles', 'doubles'] as const).map(format => (
              <p key={format} className="text-sm capitalize">{format} · {stats[format].wins} won · {stats[format].losses} lost{stats[format].provisional && ' · Provisional'}</p>
            ))}
            {history.length ? <ul className="space-y-2">{history.map(entry => (
              <li key={entry.sessionId}><Link className="inline-flex min-h-11 items-center text-[#d7fc83] underline" to={`/rallies?session=${encodeURIComponent(entry.sessionId)}`}>{entry.won ? 'Win' : 'Loss'} · {entry.format} · {entry.sets.map(set => set.join('–')).join(', ')} · {new Date(entry.finalizedAt).toLocaleDateString()}</Link></li>
            ))}</ul> : <p className="text-sm text-white/75">No finalized matches have been recorded in the history collection yet.</p>}
          </div>
        </>
      )}
    </section>
  )
}
