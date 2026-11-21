import { useRef, useState, type FormEvent } from 'react'
import { useAuth, useQuery } from 'deepspace'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui'
import { isUnread, resolveNotificationTarget, runNotificationAction, unreadCount } from '@/lib/notifications'
import { parseNotificationPreferences, type RallyNotification } from '@/lib/rally-notifications'
import type { RallySession } from '@/lib/rally'

export default function NotificationsPage() {
  const { userId } = useAuth()
  return userId ? <NotificationInbox key={userId} userId={userId} /> : null
}

function NotificationInbox({ userId }: { userId: string }) {
  const { records, status } = useQuery<RallyNotification>('notifications', {
    where: { recipientId: userId }, orderBy: 'createdAt', orderDir: 'desc',
  })
  const sessions = useQuery<RallySession>('sessions')
  const visibleSessions = new Set(sessions.records.map(record => record.recordId))
  const unread = unreadCount(records)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [pending, setPending] = useState<string>()
  const inFlight = useRef(false)
  const [message, setMessage] = useState('')
  const visible = unreadOnly ? records.filter(isUnread) : records
  const [error, setError] = useState('')

  async function markRead(recordId?: string) {
    if (inFlight.current) return
    inFlight.current = true
    setPending(recordId ?? 'all')
    setError('')
    setMessage('')
    try {
      const result = await runNotificationAction(recordId ? { operation: 'markRead', recordId } : { operation: 'markAllRead' })
      if (recordId) setMessage('Marked as read.')
      else if (typeof result.count === 'number') {
        setMessage(result.count === 1 ? '1 notification marked as read.' : `${result.count} notifications marked as read.`)
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Notifications could not be updated.')
    } finally {
      inFlight.current = false
      setPending(undefined)
    }
  }

  return (
    <section aria-labelledby="notification-heading" className="mx-auto max-w-3xl space-y-5 px-4 py-8 sm:px-7">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/dashboard" className="text-sm text-muted-foreground underline">Dashboard</Link>
          <h1 id="notification-heading" className="mt-2 text-3xl font-semibold tracking-tight">Notifications</h1>
          {status === 'ready' && <p aria-live="polite" className="text-sm text-muted-foreground">{unread} unread</p>}
        </div>
        <Button type="button" disabled={Boolean(pending) || status !== 'ready' || unread === 0} onClick={() => void markRead()}>{pending === 'all' ? 'Marking as read…' : 'Mark all as read'}</Button>
      </header>
      {status === 'loading' && <p role="status">Loading notifications…</p>}
      {status === 'error' && <p role="alert">Notifications could not be loaded.</p>}
      {status === 'ready' && records.length === 0 && <p className="rounded-xl border border-dashed border-border p-5 text-muted-foreground">Schedule changes, waitlist promotions and result updates will appear here.</p>}
      {status === 'ready' && records.length > 0 && <label className="flex min-h-11 w-fit items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={unreadOnly} onChange={event => setUnreadOnly(event.target.checked)} />
        Show unread only
      </label>}
      {status === 'ready' && records.length > 0 && visible.length === 0 && <p className="rounded-xl border border-dashed border-border p-5 text-muted-foreground">You’re caught up. Clear the filter to see your read notifications.</p>}
      {error && <p role="alert" className="text-rose-300">{error}</p>}
      {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
      <ul className="space-y-3">
        {visible.map(record => {
          const { recordId, data, createdAt } = record
          const target = resolveNotificationTarget(data, visibleSessions)
          return (
            <li key={recordId} className="space-y-2 rounded-xl border border-border p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="break-words font-semibold">{data.title}</h2>
                {isUnread(record) && <span className="text-xs font-semibold text-foreground">Unread</span>}
              </div>
              <p>{data.body}</p>
              <time dateTime={createdAt} className="block text-sm text-muted-foreground">{new Date(createdAt).toLocaleString()}</time>
              <div className="flex flex-wrap items-center gap-3">
                {target.kind === 'session' && <Link className="underline" to={`/rallies?${new URLSearchParams({ session: target.sessionId })}`}>Open rally</Link>}
                {sessions.status === 'ready' && target.kind === 'unavailable' && <span className="text-sm text-muted-foreground">Rally unavailable</span>}
                {isUnread(record) && <Button type="button" variant="outline" disabled={Boolean(pending)} onClick={() => void markRead(recordId)}>{pending === recordId ? 'Marking as read…' : 'Mark as read'}</Button>}
              </div>
            </li>
          )
        })}
      </ul>
      <NotificationPreferences userId={userId} />
    </section>
  )
}

function NotificationPreferences({ userId }: { userId: string }) {
  const { records, status } = useQuery<{ preferences: string }>('notificationPreferences', { where: { userId }, limit: 1 })
  const stored = records[0]?.data.preferences
  const preferences = parseNotificationPreferences(stored)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const inFlight = useRef(false)

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current || status !== 'ready') return
    const fields = new FormData(event.currentTarget)
    inFlight.current = true
    setSaving(true)
    setError('')
    setMessage('')
    try {
      await runNotificationAction({ operation: 'setPreferences', preferences: { results: fields.has('results'), polls: fields.has('polls') } })
      setMessage('Preferences saved.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Preferences could not be saved.')
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  return (
    <details className="rounded-xl border border-border p-4">
      <summary className="min-h-11 cursor-pointer font-semibold">Notification preferences</summary>
      <p className="mb-2 text-sm text-muted-foreground">Waitlist promotions, cancellations, and schedule changes stay enabled.</p>
      {status === 'loading' && <p role="status">Loading notification preferences…</p>}
      {status === 'error' && <p role="alert">Notification preferences could not be loaded.</p>}
      {status === 'ready' && <form onSubmit={event => void save(event)} onChange={() => { setMessage(''); setError('') }}>
        <fieldset disabled={saving} key={stored} className="space-y-1">
          <legend className="sr-only">Optional in-app updates</legend>
          <label className="flex min-h-11 items-center gap-2"><input type="checkbox" name="results" defaultChecked={preferences.results} /> Match result updates</label>
          <label className="flex min-h-11 items-center gap-2"><input type="checkbox" name="polls" defaultChecked={preferences.polls} /> Scheduling polls</label>
          <Button type="submit" variant="outline">{saving ? 'Saving preferences…' : 'Save preferences'}</Button>
        </fieldset>
      </form>}
      {error && <p role="alert" className="mt-2 text-rose-300">{error}</p>}
      {message && <p role="status" className="mt-2 text-sm text-muted-foreground">{message}</p>}
    </details>
  )
}
