import { useRef, useState, type FormEvent } from 'react'
import { useQuery } from 'deepspace'
import { Button, ConfirmModal } from '@/components/ui'
import { parsePollOptions, parsePollTally, POLL_MAX_OPTIONS, POLL_MIN_OPTIONS } from '@/lib/polls'
import { formatSessionTime } from '@/lib/rally'
import { buildPollDraft } from '@/lib/poll-draft'
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
  const [message, setMessage] = useState('')
  const [optionCount, setOptionCount] = useState(POLL_MIN_OPTIONS)
  const inFlight = useRef(false)
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const poll = records.find(record => record.data.status === 'open' || record.data.status === 'finalizing')
  const latest = records[0]
  const confirmedTime = latest?.data.status === 'finalized'
    ? parsePollOptions(latest.data.options)?.find(option => option.id === latest.data.finalizedOptionId)
    : undefined

  async function run(command: Parameters<typeof runRallyCommand>[0], success: string) {
    if (inFlight.current) return false
    inFlight.current = true
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await runRallyCommand(command)
      setMessage(success)
      return true
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The scheduling poll could not be updated.')
      return false
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    const draft = buildPollDraft(Array.from({ length: optionCount }, (_, index) => String(fields.get(`option-${index}`) ?? '')))
    if ('error' in draft) {
      setError(draft.error)
      return
    }
    void run({ operation: 'createPoll', sessionId, options: draft.options }, 'Poll opened.')
  }

  if (status === 'ready' && !latest && !isHost) return null
  return (
    <section className="space-y-3 rounded-xl border border-border p-4">
      <h3 className="font-semibold">Scheduling poll</h3>
      {status === 'loading' && <p role="status">Loading the scheduling poll…</p>}
      {status === 'error' && <p role="alert">The scheduling poll could not be loaded.</p>}
      {status === 'ready' && poll && (
        <PollOptions {...{ sessionId, userId, isHost, busy, run, error }} clearError={() => setError('')} poll={poll} />
      )}
      {status === 'ready' && !poll && confirmedTime && (
        <p>Confirmed time <time dateTime={confirmedTime.startsAt}>{formatSessionTime(confirmedTime.startsAt)}</time></p>
      )}
      {status === 'ready' && latest?.data.status === 'cancelled' && <p>The scheduling poll was cancelled.</p>}
      {status === 'ready' && !latest && isHost && (
        <form className="space-y-3" onSubmit={create} onChange={() => setError('')}>
          <p className="text-sm text-muted-foreground">Propose two to five future times. Times are entered in {zone}.</p>
          <fieldset disabled={busy} className="grid gap-2 sm:grid-cols-2">
            <legend className="sr-only">Proposed rally times</legend>
            {Array.from({ length: optionCount }, (_, index) => (
              <label key={index} className="grid min-w-0 gap-1 text-sm">Option {index + 1}
                <input required name={`option-${index}`} type="datetime-local" className="min-h-11 min-w-0 rounded border border-border bg-background p-2" />
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>{busy ? 'Opening poll…' : 'Open poll'}</Button>
            {optionCount < POLL_MAX_OPTIONS && <Button type="button" variant="outline" disabled={busy} onClick={() => setOptionCount(value => value + 1)}>Add a time</Button>}
            {optionCount > POLL_MIN_OPTIONS && <Button type="button" variant="ghost" disabled={busy} onClick={() => setOptionCount(value => value - 1)}>Remove last time</Button>}
          </div>
        </form>
      )}
      {error && !poll && <p role="alert" className="text-rose-300">{error}</p>}
      {poll && busy && <p role="status" className="text-sm text-muted-foreground">Saving poll changes…</p>}
      {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
    </section>
  )
}

function PollOptions({ sessionId, userId, isHost, poll, busy, run, error, clearError }: Props & {
  poll: { recordId: string; data: RallyPoll }
  busy: boolean
  error: string
  clearError: () => void
  run: (command: Parameters<typeof runRallyCommand>[0], message: string) => Promise<boolean>
}) {
  const pollId = poll.recordId
  const { records: votes, status } = useQuery<RallyPollVote>('pollVotes', { where: { pollId, userId } })
  const finalizing = poll.data.status === 'finalizing'
  const [confirmation, setConfirmation] = useState<{ kind: 'cancel' } | { kind: 'time'; optionId: string; startsAt: string }>()
  const options = parsePollOptions(poll.data.options)
  const tally = parsePollTally(poll.data.tally)
  if (!options) return <p role="alert">The proposed times could not be loaded.</p>
  return (
    <div className="space-y-3">
      {finalizing ? <p role="status">The chosen time is being confirmed.</p> : <p className="text-sm text-muted-foreground">Vote for every time you can play. The host chooses the final time.</p>}
      <ul className="space-y-2">
        {options.filter(option => !finalizing || option.id === poll.data.finalizedOptionId).map(({ id, startsAt }) => {
          const voted = votes.some(vote => vote.data.optionId === id)
          const count = tally[id] ?? 0
          return (
            <li key={id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3">
              <div className="min-w-0 grow">
                <time className="block font-semibold" dateTime={startsAt}>{formatSessionTime(startsAt)}</time>
                <span className="text-sm text-muted-foreground">{count} {count === 1 ? 'vote' : 'votes'}{status === 'ready' && voted ? ' · You voted' : ''}</span>
              </div>
              {!finalizing && <Button type="button" variant="outline" disabled={busy || status !== 'ready'} onClick={() => void run({
                operation: voted ? 'withdrawVote' : 'castVote', sessionId, pollId, optionId: id,
              }, voted ? 'Vote withdrawn.' : 'Vote saved.')} aria-label={`${voted ? 'Withdraw vote for' : 'Vote for'} ${formatSessionTime(startsAt)}`}>{voted ? 'Withdraw vote' : 'Vote'}</Button>}
              {isHost && <Button type="button" disabled={busy} onClick={() => { clearError(); setConfirmation({ kind: 'time', optionId: id, startsAt }) }}
                aria-label={`${finalizing ? 'Retry confirmation for' : 'Confirm time'} ${formatSessionTime(startsAt)}`}>{finalizing ? 'Retry confirmation' : 'Confirm time'}</Button>}
            </li>
          )
        })}
      </ul>
      {status === 'error' && <p role="alert">Your votes could not be loaded.</p>}
      {isHost && !finalizing && <Button type="button" variant="outline" disabled={busy} onClick={() => { clearError(); setConfirmation({ kind: 'cancel' }) }}>Cancel poll</Button>}
      {error && !confirmation && <p role="alert" className="text-rose-300">{error}</p>}
      <ConfirmModal error={error} open={Boolean(confirmation)} onClose={() => { if (!busy) setConfirmation(undefined) }}
        title={confirmation?.kind === 'cancel' ? 'Cancel this scheduling poll?' : 'Confirm the rally time?'}
        description={confirmation?.kind === 'time' ? `${formatSessionTime(confirmation.startsAt)} will become the rally’s scheduled time.` : 'The current rally time will stay in place.'}
        confirmText={confirmation?.kind === 'cancel' ? 'Cancel poll' : finalizing ? 'Retry confirmation' : 'Confirm time'}
        variant={confirmation?.kind === 'cancel' ? 'destructive' : 'default'}
        cancelText={confirmation?.kind === 'cancel' ? 'Keep poll open' : 'Go back'}
        loading={busy}
        onConfirm={() => {
          if (!confirmation || busy) return
          const result = confirmation.kind === 'cancel'
            ? run({ operation: 'cancelPoll', sessionId, pollId }, 'Poll cancelled.')
            : run({ operation: 'finalizePoll', sessionId, pollId, optionId: confirmation.optionId }, 'Rally time confirmed.')
          void result.then(saved => { if (saved) setConfirmation(undefined) })
        }} />
    </div>
  )
}
