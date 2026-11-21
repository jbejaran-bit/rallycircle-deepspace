import { useRef, useState, type FormEvent } from 'react'
import { useAuth, useQuery } from 'deepspace'
import { Link } from 'react-router-dom'
import { Button, ConfirmModal } from '@/components/ui'
import { parseLocalSessionStart, type RallySession } from '@/lib/rally'
import { runSchedulingAction } from '@/lib/rally-actions'
import { parseSeriesTemplate, type SeriesTemplate } from '@/lib/recurrence'
import type { RecurringSeriesRecord } from '@/server/rally-command-room'

const input = 'block min-h-11 w-full rounded-md border border-border bg-background px-3 text-foreground'

export default function SeriesPage() {
  const { userId } = useAuth()
  return userId ? <SeriesManager key={userId} userId={userId} /> : null
}

function toTemplate(session: RallySession): SeriesTemplate {
  const { title, court, location, format, durationMinutes, targetPlayers, capacity, level, notes } = session
  return { title, court, location, format, durationMinutes, targetPlayers, capacity, level, notes }
}

function localDate(value: string): string {
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function SeriesManager({ userId }: { userId: string }) {
  const series = useQuery<RecurringSeriesRecord>('recurringSeries', { where: { hostId: userId } })
  const sessions = useQuery<RallySession>('sessions', { where: { hostId: userId } })
  const [editing, setEditing] = useState<string>()
  const [cancel, setCancel] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const draft = useRef<string>(undefined)
  const current = series.records.find(record => record.recordId === editing)?.data

  async function run(command: Parameters<typeof runSchedulingAction>[0], success: string) {
    setBusy(true)
    setMessage('')
    setError('')
    try {
      await runSchedulingAction(command)
      if (command.operation === 'createSeries') draft.current = undefined
      setEditing(undefined)
      setCancel(undefined)
      setMessage(success)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The series could not be updated.')
    } finally {
      setBusy(false)
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    const start = parseLocalSessionStart(String(fields.get('start')))
    const source = sessions.records.find(record => record.recordId === fields.get('source'))?.data
    const template = source ? toTemplate(source) : parseSeriesTemplate(current?.template)
    if (!start || !template) {
      setError('Choose a rally and a valid first date.')
      return
    }
    const seriesId = editing ?? (draft.current ??= crypto.randomUUID())
    void run({
      operation: editing ? 'editSeries' : 'createSeries', seriesId, template,
      startStartsAt: start.toISOString(), intervalWeeks: Number(fields.get('interval')), count: Number(fields.get('count')),
    }, editing ? 'Draft updated.' : 'Draft saved. Publish it when you’re ready to invite players.')
  }

  return (
    <section aria-labelledby="series-heading" className="mx-auto max-w-3xl space-y-5 px-4 py-8 sm:px-7">
      <Link to="/dashboard" className="text-sm text-muted-foreground underline">Dashboard</Link>
      <h1 id="series-heading" className="text-3xl font-semibold tracking-tight">Recurring rallies</h1>
      <p className="text-muted-foreground">Reuse a rally you hosted to schedule up to 12 sessions.</p>
      {sessions.status === 'error' || series.status === 'error' ? <p role="alert">Series data could not be loaded.</p> : null}
      {sessions.status === 'ready' && series.status === 'ready' && (sessions.records.length > 0 || current) && (
        <form key={editing ?? 'create'} onSubmit={save} className="grid gap-3 rounded-xl border border-border p-4 sm:grid-cols-2">
          <label className="grid gap-1 text-sm">Rally template
            <select className={input} name="source" defaultValue="" required={!current}>
              <option value="">{current ? 'Keep the current template' : 'Choose a rally you hosted'}</option>
              {sessions.records.map(record => <option key={record.recordId} value={record.recordId}>{record.data.title}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm">First session
            <input className={input} name="start" type="datetime-local" required defaultValue={current ? localDate(current.startStartsAt) : ''} />
          </label>
          <label className="grid gap-1 text-sm">Weeks between sessions
            <input className={input} name="interval" type="number" min="1" max="4" required defaultValue={current?.intervalWeeks ?? 1} />
          </label>
          <label className="grid gap-1 text-sm">Number of sessions
            <input className={input} name="count" type="number" min="2" max="12" required defaultValue={current?.count ?? 4} />
          </label>
          <p className="text-sm text-muted-foreground sm:col-span-2">Sessions repeat at fixed intervals. Local times can shift when daylight saving time changes.</p>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button type="submit" disabled={busy}>{editing ? 'Save changes' : 'Save draft'}</Button>
            {editing && <Button type="button" variant="outline" disabled={busy} onClick={() => setEditing(undefined)}>Discard changes</Button>}
          </div>
        </form>
      )}
      {sessions.status === 'ready' && sessions.records.length === 0 && !current && (
        <Link className="underline" to="/rallies?create=1">Create a rally to use as your template</Link>
      )}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert" className="text-rose-300">{error}</p>}
      <ul className="space-y-3">
        {series.records.map(({ recordId, data }) => (
          <li key={recordId} className="space-y-2 rounded-xl border border-border p-4">
            <h2 className="font-semibold">{parseSeriesTemplate(data.template)?.title ?? 'Rally series'}</h2>
            <p className="text-sm text-muted-foreground">
              {data.status === 'cancelled' ? 'Cancelled' : data.generatedCount ? `${data.generatedCount} sessions published` : 'Draft'}
            </p>
            {data.status === 'active' && <div className="flex flex-wrap gap-2">
              {!data.generatedCount && <Button type="button" variant="outline" disabled={busy} onClick={() => setEditing(recordId)}>Edit draft</Button>}
              {data.generatedCount < data.count && <Button type="button" disabled={busy} onClick={() => void run({ operation: 'generateOccurrences', seriesId: recordId }, 'Series sessions published.')}>Publish sessions</Button>}
              <Button type="button" variant="outline" disabled={busy} onClick={() => setCancel(recordId)}>Cancel series</Button>
            </div>}
          </li>
        ))}
      </ul>
      <ConfirmModal open={Boolean(cancel)} onClose={() => setCancel(undefined)}
        onConfirm={() => { if (cancel) void run({ operation: 'cancelSeries', seriesId: cancel }, 'Series cancelled.') }}
        title="Cancel this series?" description="Future sessions in the series will be cancelled."
        confirmText="Cancel series" variant="destructive" loading={busy} />
    </section>
  )
}
