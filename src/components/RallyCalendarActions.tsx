import { useId, useRef, useState } from 'react'
import { CalendarDays, ExternalLink } from 'lucide-react'
import type { RallySession, RSVPStatus } from '@/lib/rally'
import { buildGoogleCalendarUrl, calendarTimeZone, canDownloadCalendar } from '@/lib/rally-calendar'
import { GOOGLE_CALENDAR_DIRECT_SAVE_ENABLED } from '@/lib/calendar-feature-flags'
import { disconnectCalendarGoogle, saveGoogleCalendarEvent, type GoogleCalendarSaveResult } from '@/lib/google-calendar-save'

type Props = { session: RallySession; invitationUrl: string; userId: string; response?: RSVPStatus }
const action = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/25 px-3 py-2 text-sm font-semibold text-white hover:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary'

function DirectSave({ session, invitationUrl }: Pick<Props, 'session' | 'invitationUrl'>) {
  const lock = useRef(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<GoogleCalendarSaveResult | null>(null)
  async function save() {
    if (lock.current || result?.state === 'saved' || result?.state === 'uncertain') return
    lock.current = true
    setBusy(true)
    try { setResult(await saveGoogleCalendarEvent(session, invitationUrl)) }
    finally { lock.current = false; setBusy(false) }
  }
  async function disconnect() {
    if (lock.current) return
    lock.current = true; setBusy(true)
    try {
      const error = await disconnectCalendarGoogle()
      setResult(error ? { state: 'error', message: error } : null)
    } finally { lock.current = false; setBusy(false) }
  }
  return <div className="mt-3 space-y-2 border-t border-white/15 pt-3">
    <p className="text-xs text-white/75">Direct save uses your connected Google account and DeepSpace credits. Catalog base price: $0.013 per request. No invitations are sent.</p>
    <button type="button" className={action} disabled={busy || result?.state === 'saved' || result?.state === 'uncertain'} aria-busy={busy} onClick={() => void save()}>
      {busy ? 'Waiting for Google…' : result?.state === 'saved' ? 'Saved to Google Calendar' : 'Save directly to Google Calendar'}
    </button>
    {result?.state === 'authorization' && <p className="text-sm text-white/80">
      <a href={result.authUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">Connect Google Calendar (opens a new tab)</a>. After connecting, return here and select Save directly to Google Calendar. No event has been saved yet.
    </p>}
    <p role="status" className="text-sm text-white/80">{result?.state === 'saved' ? 'Google confirmed that this session was saved.' : ''}</p>
    {result?.state === 'saved' && result.eventUrl && <a href={result.eventUrl} target="_blank" rel="noopener noreferrer" className="text-sm underline underline-offset-4">View saved event in Google Calendar</a>}
    {(result?.state === 'error' || result?.state === 'uncertain' || result?.state === 'reconnect') && <p role="alert" className="text-sm text-rose-200">{result.message}</p>}
    {result?.state === 'reconnect' && <div>
      <p className="mb-2 text-xs text-white/75">Disconnecting removes this Google connection for all Google features in RallyCircle. The next save will ask you to connect again.</p>
      <button type="button" className={action} disabled={busy} onClick={() => void disconnect()}>Disconnect Google to reconnect</button>
    </div>}
  </div>
}

export function RallyCalendarActions({ session, invitationUrl, userId, response }: Props) {
  const helpId = useId()
  const eligible = canDownloadCalendar(session, userId, response)
  const cancelled = session.status === 'cancelled' && Boolean(userId) && (session.hostId === userId || response === 'going')
  const timeZone = calendarTimeZone()
  const googleUrl = eligible ? buildGoogleCalendarUrl(session, invitationUrl, timeZone) : null
  if (cancelled) return <p className="text-xs leading-relaxed text-white/75">This session is cancelled. Existing calendar copies do not update automatically.</p>
  if (!googleUrl) return null
  return <div className="basis-full space-y-2" aria-label="Calendar options">
    <div className="flex flex-wrap gap-2">
      {googleUrl && <a href={googleUrl} target="_blank" rel="noopener noreferrer" aria-describedby={helpId} className={action}>
        <CalendarDays size={16} aria-hidden />Add to Google Calendar<ExternalLink size={13} aria-hidden />
      </a>}
    </div>
    <p id={helpId} className="text-xs leading-relaxed text-white/75">Google Calendar opens in a new tab. Review the event and select Save. Times use {timeZone}.</p>
    {GOOGLE_CALENDAR_DIRECT_SAVE_ENABLED && eligible && googleUrl && <DirectSave key={`${invitationUrl}:${JSON.stringify(session)}`} session={session} invitationUrl={invitationUrl} />}
  </div>
}
