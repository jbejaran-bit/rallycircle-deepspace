import { useState, type FormEvent } from 'react'
import { useQuery } from 'deepspace'
import { Button } from '@/components/ui'
import { parsePollOptions, parsePollTally } from '@/lib/polls'
import { parseLocalSessionStart } from '@/lib/rally'
import { runRallyCommand } from '@/lib/rally-actions'
import type { RallyPoll, RallyPollVote } from '@/server/rally-command-room'

interface Props {
  sessionId: string
  userId: string
  isHost: boolean
}

export default function RallySchedulingPoll({ sessionId, userId, isHost }: Props) {
  const { records, status } = useQuery<RallyPoll>('polls', {
    where: { sessionId }, orderBy: 'createdAt', orderDir: 'desc',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const poll = records.find(record => record.data.status === 'open')
  const latest = records[0]
  const confirmedTime = latest?.data.status === 'finalized'
    ? parsePollOptions(latest.data.options)?.find(option => option.id === latest.data.finalizedOptionId)
    : undefined

  async function run(command: Parameters<typeof runRallyCommand>[0]) {
    setBusy(true)
    setError('')
    try {
      await runRallyCommand(command)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The scheduling poll could not be updated.')
    } finally {
      setBusy(false)
    }
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    const first = parseLocalSessionStart(String(fields.get('first') ?? ''))
    const second = parseLocalSessionStart(String(fields.get('second') ?? ''))
    if (!first || !second || first.getTime() === second.getTime()) {
      setError('Choose two different times.')
      return
    }
    void run({
      operation: 'createPoll',
      sessionId,
      options: [{ id: 'first', startsAt: first.toISOString() }, { id: 'second', startsAt: second.toISOString() }],
    })
  }

  if (status === 'ready' && !latest && !isHost) return null
  return (
    <section className="space-y-3 rounded-xl border border-border p-4">
      <h3 className="font-semibold">Scheduling poll</h3>
      {status === 'loading' && <p role="status">Loading the scheduling poll…</p>}
      {status === 'error' && <p role="alert">The scheduling poll could not be loaded.</p>}
      {status === 'ready' && poll && (
        <PollOptions {...{ sessionId, userId, isHost, busy, run }} poll={poll} />
      )}
      {status === 'ready' && !poll && confirmedTime && (
        <p>Confirmed time <time dateTime={confirmedTime.startsAt}>{new Date(confirmedTime.startsAt).toLocaleString()}</time></p>
      )}
      {status === 'ready' && latest?.data.status === 'cancelled' && <p>The scheduling poll was cancelled.</p>}
      {status === 'ready' && !latest && isHost && (
        <form className="flex flex-wrap items-end gap-3" onSubmit={create}>
          <label className="grid gap-1">First time
            <input required name="first" type="datetime-local" className="rounded border border-border bg-background p-2" />
          </label>
          <label className="grid gap-1">Second time
            <input required name="second" type="datetime-local" className="rounded border border-border bg-background p-2" />
          </label>
          <Button type="submit" disabled={busy}>Open poll</Button>
        </form>
      )}
      {error && <p role="alert" className="text-rose-300">{error}</p>}
    </section>
  )
}

function PollOptions({ sessionId, userId, isHost, poll, busy, run }: Props & {
  poll: { recordId: string; data: RallyPoll }
  busy: boolean
  run: (command: Parameters<typeof runRallyCommand>[0]) => Promise<void>
}) {
  const pollId = poll.recordId
  const { records: votes, status } = useQuery<RallyPollVote>('pollVotes', { where: { pollId, userId } })
  const options = parsePollOptions(poll.data.options)
  const tally = parsePollTally(poll.data.tally)
  if (!options) return <p role="alert">The proposed times could not be loaded.</p>
  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {options.map(({ id, startsAt }) => {
          const voted = votes.some(vote => vote.data.optionId === id)
          const count = tally[id] ?? 0
          return (
            <li key={id} className="flex flex-wrap items-center gap-2">
              <time dateTime={startsAt}>{new Date(startsAt).toLocaleString()}</time>
              <span className="text-sm text-muted-foreground">{count} {count === 1 ? 'vote' : 'votes'}</span>
              <Button type="button" variant="outline" disabled={busy || status !== 'ready'} onClick={() => void run({
                operation: voted ? 'withdrawVote' : 'castVote', sessionId, pollId, optionId: id,
              })}>{voted ? 'Withdraw vote' : 'Vote'}</Button>
              {isHost && <Button type="button" disabled={busy} onClick={() => void run({
                operation: 'finalizePoll', sessionId, pollId, optionId: id,
              })}>Confirm time</Button>}
            </li>
          )
        })}
      </ul>
      {status === 'error' && <p role="alert">Your votes could not be loaded.</p>}
      {isHost && <Button type="button" variant="outline" disabled={busy} onClick={() => void run({
        operation: 'cancelPoll', sessionId, pollId,
      })}>Cancel poll</Button>}
    </div>
  )
}
