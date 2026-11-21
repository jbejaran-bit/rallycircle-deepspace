import { ConfirmModal } from '@/components/ui'
import { useEffect, useRef, useState } from 'react'
import type { RallySession } from '@/lib/rally'
import { runRallyCommand } from '@/lib/rally-actions'
import { displayPoints, isTiebreak, readMatchScore, resultStatus, type ScoreSide } from '@/lib/rally-score'

interface Props {
  session: RallySession
  sessionId: string
  userId: string
  isHost: boolean
  players: { id: string; name: string }[]
  nameOf: (id: string) => string
}

const resultLabels = {
  'in-progress': 'In progress',
  proposed: 'Proposed result',
  confirmed: 'Partially confirmed result',
  disputed: 'Disputed result',
  final: 'Final result',
}

const sides = [0, 1] as const
const button = 'min-h-11 rounded-lg border border-white/25 px-3 text-sm font-semibold focus-visible:outline-2 disabled:opacity-50'

export default function RallyScoreboard({ session, sessionId, userId, isHost, players, nameOf }: Props) {
  const inFlight = useRef(false)
  const [review, setReview] = useState<'approve' | 'dispute' | null>(null)
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [awaitingRevision, setAwaitingRevision] = useState<number | null>(null)
  const [slowRevision, setSlowRevision] = useState<number | null>(null)
  const score = readMatchScore(session.matchScore)
  const result = score && resultStatus(score)
  const waitingForScore = score !== null && awaitingRevision !== null && score.revision === awaitingRevision
  useEffect(() => {
    if (!waitingForScore) return
    const timer = window.setTimeout(() => setSlowRevision(awaitingRevision), 5000)
    return () => window.clearTimeout(timer)
  }, [awaitingRevision, waitingForScore])
  const canReview = session.status === 'open' && score &&
    (result === 'proposed' || result === 'confirmed') &&
    score.teams.flat().includes(userId) && !score.approvals.includes(userId)
  const editable = isHost && session.status === 'open'
  const teamSize = session.format === 'Singles' ? 1 : session.format === 'Doubles' ? 2 : 0

  if (!score && (!editable || !teamSize)) return null
  const teams = sides.map(team => Array.from({ length: teamSize }, (_, index) => selected[`${team}-${index}`] ?? ''))
  const distinctPlayers = new Set(teams.flat())
  const canStart = !session.matchScore && distinctPlayers.size === teamSize * 2 && !distinctPlayers.has('')

  async function edit(command: Parameters<typeof runRallyCommand>[0]) {
    if (inFlight.current) return
    inFlight.current = true
    setPending(true)
    setError('')
    try {
      await runRallyCommand(command)
      if (command.operation === 'scorePoint') {
        setSlowRevision(null)
        setAwaitingRevision(command.revision)
      }
      if (command.operation === 'reviewResult') setReview(null)
    } catch (cause) {
      setReview(null)
      setError(cause instanceof Error ? cause.message : 'The score could not be saved.')
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }

  function point(side: ScoreSide) {
    if (score && !waitingForScore) void edit({ operation: 'scorePoint', sessionId, revision: score.revision, side })
  }

  return (
    <section className="space-y-4 rounded-2xl border border-white/15 bg-[#111e15] p-4 sm:p-5" aria-label="Match scoreboard">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-bold">Match scoreboard</h3>
        {score && result && <span className="rounded-full border border-[#d7fc83]/30 bg-[#d7fc83]/10 px-3 py-1 text-xs font-semibold text-[#d7fc83]">{resultLabels[result]}</span>}
      </header>
      {score ? (
        <>
          <p role="status" className="text-sm text-white/80">
            {score.winner !== null ? `${resultLabels[resultStatus(score)]} · Side ${score.winner + 1} won the match.`
              : session.status !== 'open' ? 'Scoring closed.'
              : isTiebreak(score) ? 'Tiebreak · first to seven, win by two' : 'In progress'}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-y-2 text-left text-sm tabular-nums">
              <thead><tr><th scope="col" className="px-2 pb-1">Players</th>{score.sets.map((_, index) => <th scope="col" key={index} className="px-2 text-center">Set {index + 1}</th>)}{score.winner === null && <><th scope="col" className="px-2 text-center">Games</th><th scope="col" className="px-2 text-center">Points</th></>}</tr></thead>
              <tbody>
                {sides.map(side => (
                  <tr key={side} className={score.winner === side ? "bg-[#d7fc83]/15" : "bg-white/5"}>
                    <th scope="row" className="rounded-l-lg px-2 py-3">{score.teams[side].map(nameOf).join(' / ')}</th>
                    {score.sets.map((set, index) => <td key={index} className="px-2 text-center font-semibold">{set[side]}</td>)}
                    {score.winner === null && <><td className="px-2 text-center font-semibold">{score.games[side]}</td><td className="rounded-r-lg px-2 text-center text-lg font-bold text-[#d7fc83]">{displayPoints(score, side)}</td></>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {canReview && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className={button} disabled={pending} onClick={() => setReview('approve')}>Confirm result</button>
              <button type="button" className={button} disabled={pending} onClick={() => setReview('dispute')}>Dispute result</button>
            </div>
          )}
          {editable && score.winner === null && (
            <div className="flex flex-wrap gap-2">
              {sides.map(side => <button key={side} className={button} type="button" disabled={pending || waitingForScore} onClick={() => point(side)}>Point to side {side + 1}</button>)}
            </div>
          )}
        </>
      ) : session.matchScore ? <p role="alert">The saved score could not be read.</p> : (
        <>
          <p className="text-sm text-white/80">Best of three sets. Select {teamSize * 2} distinct players with confirmed RSVPs.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {teams.map((team, side) => (
              <fieldset key={side} className="space-y-2">
                <legend>Side {side + 1}</legend>
                {team.map((playerId, index) => {
                  const key = `${side}-${index}`
                  return (
                    <label key={key} className="block text-sm">
                      Player {index + 1}
                      <select className="mt-1 block min-h-11 w-full rounded-lg border border-white/25 bg-[#17201c] px-2" value={playerId} onChange={event => setSelected({ ...selected, [key]: event.target.value })}>
                        <option value="">Choose a player</option>
                        {players.map(player => <option key={player.id} value={player.id}>{player.name}</option>)}
                      </select>
                    </label>
                  )
                })}
              </fieldset>
            ))}
          </div>
          <button className={button} type="button" disabled={!canStart || pending} onClick={() => void edit({ operation: 'startMatch', sessionId, teams: [teams[0], teams[1]] })}>Start match</button>
        </>
      )}
      {score?.winner != null && (result === 'proposed' || result === 'confirmed') && (
        <p className="text-sm text-white/75">{score.approvals.length} of {score.teams.flat().length} recorded players approved this result.</p>
      )}
      <ConfirmModal
        open={review !== null && Boolean(canReview)}
        onClose={() => { if (!inFlight.current) setReview(null) }}
        onConfirm={() => { if (review && canReview) void edit({ operation: 'reviewResult', sessionId, decision: review }) }}
        title={review === 'dispute' ? 'Dispute this result?' : 'Confirm this result?'}
        description={review === 'dispute' ? 'A dispute closes further approvals for this result.' : 'The result becomes final after every recorded player approves it.'}
        confirmText={review === 'dispute' ? 'Dispute result' : 'Confirm result'}
        variant={review === 'dispute' ? 'destructive' : 'default'}
        loading={pending}
      />
      {pending && <p role="status">Saving score…</p>}
      {waitingForScore && (
        <div role="status" className="text-sm text-white/75">
          {slowRevision === awaitingRevision ? (
            <><p>Point saved. The live scoreboard has not caught up yet.</p><button type="button" className={button} onClick={() => window.location.reload()}>Reload latest score</button></>
          ) : 'Point saved. Waiting for the live score…'}
        </div>
      )}
      {error && <p role="alert" className="text-sm text-rose-200">{error}</p>}
    </section>
  )
}
