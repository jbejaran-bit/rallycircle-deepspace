import { useState } from 'react'
import { useAuth, useQuery } from 'deepspace'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui'
import { isUnread, resolveNotificationTarget, runNotificationAction, unreadCount } from '@/lib/notifications'
import type { RallyNotification } from '@/lib/rally-notifications'
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function markRead(recordId?: string) {
    setBusy(true)
    setError('')
    try {
      await runNotificationAction(recordId ? { operation: 'markRead', recordId } : { operation: 'markAllRead' })
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Notifications could not be updated.')
    } finally {
      setBusy(false)
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
        <Button type="button" disabled={busy || unread === 0} onClick={() => void markRead()}>Mark all as read</Button>
      </header>
      {status === 'loading' && <p role="status">Loading notifications…</p>}
      {status === 'error' && <p role="alert">Notifications could not be loaded.</p>}
      {status === 'ready' && records.length === 0 && <p className="rounded-xl border border-dashed border-border p-5 text-muted-foreground">Schedule changes, waitlist promotions and result updates will appear here.</p>}
      {error && <p role="alert" className="text-rose-300">{error}</p>}
      <ul className="space-y-3">
        {records.map(record => {
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
                {isUnread(record) && <Button type="button" variant="outline" disabled={busy} onClick={() => void markRead(recordId)}>Mark as read</Button>}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
