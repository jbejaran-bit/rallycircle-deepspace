import { useState } from 'react'
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
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const score = readMatchScore(session.matchScore)
  const result = score && resultStatus(score)
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
    setPending(true)
    setError('')
    try {
      await runRallyCommand(command)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The score could not be saved.')
    } finally {
      setPending(false)
    }
  }

  function point(side: ScoreSide) {
    if (score) void edit({ operation: 'scorePoint', sessionId, revision: score.revision, side })
  }

  return (
    <section className="space-y-3 rounded-2xl border border-white/15 p-4" aria-label="Match scoreboard">
      <h3 className="font-bold">Match scoreboard</h3>
      {score ? (
        <>
          <p role="status" className="text-sm text-white/80">
            {score.winner !== null ? `${resultLabels[resultStatus(score)]} · Side ${score.winner + 1} won the match.`
              : session.status !== 'open' ? 'Scoring closed.'
              : isTiebreak(score) ? 'Tiebreak · first to seven, win by two' : 'In progress'}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead><tr><th scope="col">Players</th>{score.sets.map((_, index) => <th scope="col" key={index}>Set {index + 1}</th>)}{score.winner === null && <><th scope="col">Games</th><th scope="col">Points</th></>}</tr></thead>
              <tbody>
                {sides.map(side => (
                  <tr key={side}>
                    <th scope="row" className="py-2 pr-3">{score.teams[side].map(nameOf).join(' / ')}</th>
                    {score.sets.map((set, index) => <td key={index}>{set[side]}</td>)}
                    {score.winner === null && <><td>{score.games[side]}</td><td>{displayPoints(score, side)}</td></>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {canReview && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className={button} disabled={pending} onClick={() => void edit({ operation: 'reviewResult', sessionId, decision: 'approve' })}>Confirm result</button>
              <button type="button" className={button} disabled={pending} onClick={() => void edit({ operation: 'reviewResult', sessionId, decision: 'dispute' })}>Dispute result</button>
            </div>
          )}
          {editable && score.winner === null && (
            <div className="flex flex-wrap gap-2">
              {sides.map(side => <button key={side} className={button} type="button" disabled={pending} onClick={() => point(side)}>Point to side {side + 1}</button>)}
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
      {pending && <p role="status">Saving score…</p>}
      {error && <p role="alert" className="text-sm text-rose-200">{error}</p>}
    </section>
  )
}
