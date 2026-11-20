import { useState, type FormEvent } from 'react'
import { usePresenceRoom, useQuery, useUserLookup } from 'deepspace'
import { Pencil, Trophy } from 'lucide-react'
import { isScoreboardConflict, runScoreboardCommand } from '@/lib/scoreboard-actions'
import {
  formatMatchTiebreak,
  formatSetScores,
  MAX_SETS,
  scoreboardStatusLabel,
  scoreboardWinner,
  setsWon,
  validateScoreboardInput,
  type MatchScoreboard,
  type ScoreboardInput,
  type ScoreboardStatus,
  type SetScore,
} from '@/lib/scoreboard'

const field = 'w-full rounded-xl border border-white/15 bg-[#0e1513] px-3.5 py-3 text-sm text-white outline-none transition focus:border-[#d7fc83] focus:ring-1 focus:ring-[#d7fc83]'
const accent = 'rounded-xl bg-[#d7fc83] px-4 py-3 text-sm font-bold text-[#101a13] transition hover:bg-[#ebffb8] disabled:cursor-not-allowed disabled:opacity-50'

function ErrorMessage({ message }: { message: string | null }) {
  return message ? <p role="alert" className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-sm text-rose-200">{message}</p> : null
}

type SetDraft = { a: string; b: string }

function emptySetDrafts(): SetDraft[] {
  return Array.from({ length: MAX_SETS }, () => ({ a: '', b: '' }))
}

function draftsFromSets(sets: SetScore[]): SetDraft[] {
  const drafts = emptySetDrafts()
  sets.forEach((set, i) => {
    if (i < MAX_SETS) drafts[i] = { a: String(set.a), b: String(set.b) }
  })
  return drafts
}

function ScoreForm({
  sessionId,
  record,
  onDone,
  onConflict,
}: {
  sessionId: string
  record: { recordId: string; data: MatchScoreboard } | null
  onDone: () => void
  onConflict: (message: string) => void
}) {
  const current = record?.data ?? null
  const [teamAName, setTeamAName] = useState(current?.teamAName ?? 'Team A')
  const [teamBName, setTeamBName] = useState(current?.teamBName ?? 'Team B')
  const [status, setStatus] = useState<ScoreboardStatus>(current?.status ?? 'not_started')
  const [sets, setSets] = useState<SetDraft[]>(() => draftsFromSets(current?.sets ?? []))
  const [tiebreakA, setTiebreakA] = useState(current?.matchTiebreak ? String(current.matchTiebreak.a) : '')
  const [tiebreakB, setTiebreakB] = useState(current?.matchTiebreak ? String(current.matchTiebreak.b) : '')
  const [correction, setCorrection] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The deciding tiebreak only applies when the sets are split 1–1.
  const parsedSets: SetScore[] = []
  let setsParseError: string | null = null
  sets.forEach((draft, i) => {
    if (draft.a === '' && draft.b === '') return
    const a = Number(draft.a)
    const b = Number(draft.b)
    if (draft.a === '' || draft.b === '' || !Number.isInteger(a) || !Number.isInteger(b)) {
      setsParseError = `Enter both teams' games for set ${i + 1}.`
      return
    }
    parsedSets.push({ a, b })
  })
  const won = setsWon(parsedSets)
  const showTiebreak = won.a === 1 && won.b === 1

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    if (setsParseError) { setError(setsParseError); return }
    const matchTiebreak =
      showTiebreak && (tiebreakA !== '' || tiebreakB !== '')
        ? { a: Number(tiebreakA), b: Number(tiebreakB) }
        : null
    if (showTiebreak && matchTiebreak && (!Number.isInteger(matchTiebreak.a) || !Number.isInteger(matchTiebreak.b))) {
      setError('Enter both teams\' points for the match tiebreak.')
      return
    }
    const input: ScoreboardInput = {
      teamAName: teamAName.trim(),
      teamBName: teamBName.trim(),
      status,
      sets: parsedSets,
      matchTiebreak,
    }
    const problem = validateScoreboardInput(input, current, correction)
    if (problem) { setError(problem); return }
    setPending(true)
    setError(null)
    try {
      await runScoreboardCommand({
        operation: 'scoreboard',
        sessionId,
        teamAName: input.teamAName,
        teamBName: input.teamBName,
        status: input.status,
        sets: input.sets,
        matchTiebreak: input.matchTiebreak,
        expectedVersion: current?.version ?? 0,
        correction,
      })
      onDone()
    } catch (cause) {
      if (isScoreboardConflict(cause)) {
        onConflict(cause instanceof Error ? cause.message : 'The score changed while you were editing.')
        onDone()
        return
      }
      setError(cause instanceof Error ? cause.message : 'The score could not be saved. Try again.')
    } finally {
      setPending(false)
    }
  }

  function updateSet(index: number, side: 'a' | 'b', value: string) {
    setSets(prev => prev.map((draft, i) => (i === index ? { ...draft, [side]: value } : draft)))
  }

  return (
    <form onSubmit={e => void submit(e)} className="space-y-4" aria-label="Edit match score">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block text-xs font-medium text-white/75">Team A name
          <input required maxLength={40} className={`${field} mt-1.5`} value={teamAName} onChange={e => setTeamAName(e.target.value)} />
        </label>
        <label className="block text-xs font-medium text-white/75">Team B name
          <input required maxLength={40} className={`${field} mt-1.5`} value={teamBName} onChange={e => setTeamBName(e.target.value)} />
        </label>
      </div>
      <label className="block text-xs font-medium text-white/75">Match status
        <select className={`${field} mt-1.5`} value={status} onChange={e => setStatus(e.target.value as ScoreboardStatus)}>
          <option value="not_started">Not started</option>
          <option value="in_progress">In progress</option>
          <option value="final">Final</option>
        </select>
      </label>
      <fieldset>
        <legend className="text-xs font-medium text-white/75">Set scores (games per set)</legend>
        <p className="mt-1 text-[11px] text-white/45">Enter completed sets only, e.g. 6–4, 7–5, or 7–6. Leave a row blank for sets not played.</p>
        <div className="mt-2 space-y-2">
          {sets.map((draft, i) => (
            <div key={i} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
              <label className="sr-only" htmlFor={`set-${i}-a`}>Set {i + 1}, {teamAName || 'Team A'} games</label>
              <input
                id={`set-${i}-a`}
                aria-label={`Set ${i + 1}, ${teamAName || 'Team A'} games`}
                type="number" inputMode="numeric" min={0} max={7} step={1}
                className={field} placeholder="–" value={draft.a}
                onChange={e => updateSet(i, 'a', e.target.value)}
              />
              <span aria-hidden className="text-sm font-bold text-white/50">–</span>
              <label className="sr-only" htmlFor={`set-${i}-b`}>Set {i + 1}, {teamBName || 'Team B'} games</label>
              <input
                id={`set-${i}-b`}
                aria-label={`Set ${i + 1}, ${teamBName || 'Team B'} games`}
                type="number" inputMode="numeric" min={0} max={7} step={1}
                className={field} placeholder="–" value={draft.b}
                onChange={e => updateSet(i, 'b', e.target.value)}
              />
            </div>
          ))}
        </div>
      </fieldset>
      {showTiebreak && (
        <fieldset>
          <legend className="text-xs font-medium text-white/75">Deciding match tiebreak (first to 10, win by 2)</legend>
          <p className="mt-1 text-[11px] text-white/45">The sets are split 1–1. Enter tiebreak points, or leave blank if it has not been played.</p>
          <div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
            <input aria-label={`Match tiebreak, ${teamAName || 'Team A'} points`} type="number" inputMode="numeric" min={0} max={99} step={1} className={field} placeholder="–" value={tiebreakA} onChange={e => setTiebreakA(e.target.value)} />
            <span aria-hidden className="text-sm font-bold text-white/50">–</span>
            <input aria-label={`Match tiebreak, ${teamBName || 'Team B'} points`} type="number" inputMode="numeric" min={0} max={99} step={1} className={field} placeholder="–" value={tiebreakB} onChange={e => setTiebreakB(e.target.value)} />
          </div>
        </fieldset>
      )}
      {current?.status === 'final' && (
        <label className="flex items-start gap-2 rounded-xl border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-xs leading-relaxed text-amber-100">
          <input type="checkbox" checked={correction} onChange={e => setCorrection(e.target.checked)} className="mt-0.5" />
          This match is final. I am correcting the recorded score.
        </label>
      )}
      <ErrorMessage message={error} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className={accent}>{pending ? 'Saving…' : 'Save score'}</button>
        <button type="button" disabled={pending} onClick={onDone} className="rounded-xl border border-white/15 px-4 py-3 text-sm font-semibold text-white/85 hover:bg-white/10 disabled:opacity-50">Cancel</button>
      </div>
    </form>
  )
}

/**
 * Live scoreboard card inside a session detail. Everyone signed in sees
 * the same synced record; only the host can edit it. Scores are shared by
 * the host and are not official or validated by any sports organization.
 */
export default function MatchScoreboard({ sessionId, isHost, cancelled }: {
  sessionId: string
  isHost: boolean
  cancelled: boolean
}) {
  const { records, status, error } = useQuery<MatchScoreboard>('matchScores', { where: { sessionId } })
  const { connected } = usePresenceRoom(`rally:${sessionId}`)
  const { getName } = useUserLookup()
  const [editing, setEditing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const record = records[0] ?? null
  const score = record?.data ?? null

  // If the live record changes under an open editor (e.g. a conflict),
  // the editor closes and the fresh score is shown instead (the conflict
  // handler calls onDone, which closes the form and shows the notice).
  if (cancelled && !score) return null

  const winner = score ? scoreboardWinner(score) : null
  const won = score ? setsWon(score.sets) : { a: 0, b: 0 }

  return (
    <section data-testid="match-scoreboard" aria-label="Match scoreboard" className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-bold text-white"><Trophy size={17} className="text-[#d7fc83]" /> Match scoreboard</h3>
        {score && (
          <span className={`rounded-full px-3 py-1 text-[11px] font-bold ${score.status === 'final' ? 'bg-[#d7fc83]/15 text-[#d7fc83]' : 'bg-white/10 text-white/75'}`}>
            {scoreboardStatusLabel(score.status)}
          </span>
        )}
      </div>

      {status === 'loading' ? (
        <p role="status" aria-busy="true" className="text-sm text-white/60">Loading the score…</p>
      ) : status === 'error' ? (
        <ErrorMessage message={error ?? 'The score could not load. Refresh to try again.'} />
      ) : !score ? (
        <div>
          <p className="text-sm text-white/60">No score yet for this match.</p>
          {isHost && !cancelled && (
            <button type="button" onClick={() => { setNotice(null); setEditing(true) }} className="mt-3 rounded-xl border border-[#d7fc83]/50 px-4 py-2.5 text-sm font-bold text-[#d7fc83] hover:bg-[#d7fc83]/10">
              Add score
            </button>
          )}
        </div>
      ) : (
        <div>
          <div className="grid grid-cols-[1fr_auto] items-center gap-3">
            <div>
              <p className="text-lg font-black text-white">{score.teamAName}</p>
              <p className="mt-1 text-lg font-black text-white">{score.teamBName}</p>
            </div>
            <div className="text-right">
              <p data-testid="scoreboard-sets" className="text-lg font-black tracking-wide text-[#d7fc83]">
                {formatSetScores(score.sets) || '–'}
              </p>
              {score.matchTiebreak && (
                <p className="mt-1 text-xs text-white/60">
                  Match tiebreak (first to 10, win by 2): <span className="font-bold text-white/85">{formatMatchTiebreak(score.matchTiebreak)}</span>
                </p>
              )}
            </div>
          </div>
          {score.sets.length > 0 && (
            <p className="mt-3 text-sm text-white/70">
              {winner
                ? `${winner === 'A' ? score.teamAName : score.teamBName} ${score.status === 'final' ? 'won' : 'leads'} ${Math.max(won.a, won.b)}–${Math.min(won.a, won.b)}`
                : `Sets split ${won.a}–${won.b}`}
            </p>
          )}
          <p className="mt-3 text-xs text-white/45">
            Last updated {new Date(record.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            {score.updatedBy ? ` by ${getName(score.updatedBy) ?? 'the host'}` : ''}.
            Scores are shared by the host and are not official or validated by any sports organization.
          </p>
          {cancelled && <p className="mt-2 text-xs font-semibold text-rose-200">This session was cancelled, so the scoreboard is closed.</p>}
        </div>
      )}

      {notice && <p role="status" className="mt-3 rounded-xl border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-sm text-amber-100">{notice}</p>}
      {!connected && status === 'ready' && (
        <p role="status" className="mt-3 text-xs text-white/50">Reconnecting — the score shown may be out of date.</p>
      )}
      {isHost && !cancelled && score && !editing && (
        <button type="button" onClick={() => { setNotice(null); setEditing(true) }} className="mt-4 inline-flex items-center gap-2 rounded-xl border border-[#d7fc83]/50 px-4 py-2.5 text-sm font-bold text-[#d7fc83] hover:bg-[#d7fc83]/10">
          <Pencil size={15} /> {score.status === 'final' ? 'Correct score' : 'Edit score'}
        </button>
      )}
      {isHost && !cancelled && editing && (
        <div className="mt-4 border-t border-white/10 pt-4">
          <ScoreForm
            sessionId={sessionId}
            record={record}
            onDone={() => setEditing(false)}
            onConflict={message => setNotice(message)}
          />
        </div>
      )}
    </section>
  )
}
