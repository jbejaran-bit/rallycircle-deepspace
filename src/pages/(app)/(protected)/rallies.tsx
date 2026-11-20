import { findCourt, type Court } from '@/lib/courts'
import { useMemo, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth, useMessages, useMutations, usePresenceRoom, useQuery, useUserLookup, type Channel, type Message } from 'deepspace'
import { CalendarDays, Check, ChevronRight, Clock3, Copy, MapPin, MessageCircle, Plus, Radio, Send, Share2, ShieldCheck, Sparkles, Users, X } from 'lucide-react'
import { buildSessionUrl, formatSessionTime, groupSessionRsvps, SESSION_FORMATS, summarizeAttendance, summarizeReadiness, validateSession, type Level, type RallyRSVP, type RallySession, type RSVPStatus, type SessionFormat } from '@/lib/rally'
import { runRallyCommand } from '@/lib/rally-actions'
import { readMatchScore } from '@/lib/rally-score'
import { buildCalendarEvent } from '@/lib/rally-calendar'
import RallyScoreboard from '@/components/RallyScoreboard'
import LiveCourtboard from '@/components/LiveCourtboard'

const surface = 'rounded-3xl border border-white/10 bg-[#141b1a] shadow-[0_18px_60px_rgba(0,0,0,0.17)]'
const field = 'w-full rounded-xl border border-white/15 bg-[#0e1513] px-3.5 py-3 text-sm text-white outline-none transition focus:border-[#d7fc83] focus:ring-1 focus:ring-[#d7fc83]'
const accent = 'rounded-xl bg-[#d7fc83] px-4 py-3 text-sm font-bold text-[#101a13] transition hover:bg-[#ebffb8] disabled:cursor-not-allowed disabled:opacity-50'

function ErrorMessage({ message }: { message: string | null }) {
  return message ? <p role="alert" className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-sm text-rose-200">{message}</p> : null
}

function ReadinessPanel({ confirmed, target, status, error, cancelled, full, format }: {
  confirmed: number
  target: number
  status: 'loading' | 'ready' | 'error'
  error?: string
  cancelled: boolean
  full: boolean
  format?: SessionFormat
}) {
  const readiness = summarizeReadiness(confirmed, target, format)
  const progressMax = Math.max(1, readiness.targetPlayers)
  const progressValue = Math.min(readiness.confirmedPlayers, progressMax)
  const progressWidth = Math.min(100, (progressValue / progressMax) * 100)

  return (
    <section data-testid="readiness-panel" aria-label="Ready to play" className="rounded-2xl border border-[#d7fc83]/20 bg-[#d7fc83]/[0.06] p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#d7fc83]">Ready to play</p>
          <p data-testid="readiness-count" className="mt-1 text-2xl font-black text-white">
            {status === 'ready' && !cancelled ? `${readiness.confirmedPlayers} / ${readiness.targetPlayers} confirmed` : 'Player confirmations'}
          </p>
        </div>
        {status === 'ready' && !cancelled && (
          <Users aria-hidden size={24} className="text-[#d7fc83]" />
        )}
      </div>
      {cancelled ? (
        <p role="status" className="mt-3 text-sm font-semibold text-rose-200">This session is cancelled; player responses are closed.</p>
      ) : status === 'loading' ? (
        <p role="status" aria-busy="true" className="mt-3 text-sm text-white/60">Loading confirmed players…</p>
      ) : status === 'error' ? (
        <ErrorMessage message={error ?? 'Player confirmations could not load. Refresh to try again.'} />
      ) : (
        <>
          <div
            role="progressbar"
            aria-label="Confirmed players toward target"
            aria-valuemin={0}
            aria-valuemax={progressMax}
            aria-valuenow={progressValue}
            className="mt-4 h-2 overflow-hidden rounded-full bg-white/10"
          >
            <div className="h-full rounded-full bg-[#d7fc83] transition-[width] duration-300" style={{ width: `${progressWidth}%` }} />
          </div>
          <div aria-live="polite" className="mt-3">
            <p data-testid="readiness-status" className={`text-sm font-bold ${readiness.ready ? 'text-[#d7fc83]' : 'text-white'}`}>
              {readiness.status}
            </p>
            {(full || readiness.detail) && <p className="mt-1 text-xs text-white/55">{full ? "This session is full." : readiness.detail}</p>}
          </div>
        </>
      )}
    </section>
  )
}

function CreateSession({ userId, onCreated, selectedCourt }: { userId: string; onCreated: (id: string) => void; selectedCourt?: Court }) {
  const { createConfirmed, putConfirmed, ready } = useMutations<Omit<RallySession, 'hostId' | 'status'>>('sessions')
  const { createConfirmed: createChannel } = useMutations<Channel>('channels')
  const [open, setOpen] = useState(Boolean(selectedCourt))
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hostRsvpError, setHostRsvpError] = useState<string | null>(null)
  const [format, setFormat] = useState<SessionFormat>('Practice')
  const [title, setTitle] = useState('')
  const [court, setCourt] = useState(selectedCourt?.name ?? '')
  const [location, setLocation] = useState(selectedCourt?.area ?? '')
  const [startsAt, setStartsAt] = useState('')
  const [durationMinutes, setDurationMinutes] = useState(90)
  const [targetPlayers, setTargetPlayers] = useState(4)
  const [capacity, setCapacity] = useState<number>()
  const [level, setLevel] = useState<Level>('All levels')
  const [notes, setNotes] = useState('')

  function fillExample() {
    const sampleTime = new Date(Date.now() + 3 * 86400_000)
    const pad = (n: number) => String(n).padStart(2, '0')
    setFormat('Doubles')
    setTitle('Weekend doubles & rally practice')
    setCourt('Schenley Park Tennis Courts')
    setLocation('Pittsburgh, PA')
    setStartsAt(`${sampleTime.getFullYear()}-${pad(sampleTime.getMonth() + 1)}-${pad(sampleTime.getDate())}T${pad(sampleTime.getHours())}:${pad(sampleTime.getMinutes())}`)
    setDurationMinutes(90)
    setTargetPlayers(4)
    setLevel('Intermediate')
    setNotes('Bring tennis balls. We’ll warm up and play doubles.')
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending || !ready || !userId) return
    const timestamp = Date.parse(startsAt)
    const candidate = {
      format, title: title.trim(), court: court.trim(), location: location.trim(),
      startsAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : startsAt,
      durationMinutes, targetPlayers, capacity, level, notes: notes.trim(),
    }
    const problem = validateSession(candidate)
    if (problem) { setError(problem); return }
    setPending(true)
    setError(null)
    setHostRsvpError(null)
    try {
      // Persist the most important product path first. Chat setup is secondary.
      const id = await createConfirmed({ ...candidate, chatChannelId: '' })
      onCreated(id)
      try {
        await runRallyCommand({ operation: 'rsvp', sessionId: id, status: 'going' })
      } catch (cause) {
        const detail = cause instanceof Error ? ` ${cause.message}` : ''
        setHostRsvpError(`Session created, but your RSVP could not be saved.${detail}`)
      }
      try {
        const channelId = await createChannel({
          name: `rally-${id}`,
          description: `Public chat for ${candidate.title}`,
          type: 'public',
          createdBy: userId,
          archived: false,
        })
        await putConfirmed(id, { chatChannelId: channelId })
      } catch (e) {
        // A session remains usable even if its optional discussion cannot initialize.
        console.warn('Session created without a chat channel', e)
      }
      setFormat('Practice')
      setCapacity(undefined)
      setTitle(''); setCourt(''); setLocation(''); setStartsAt(''); setNotes('')
      setOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create session. Try again.')
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <button type="button" className={`${accent} inline-flex items-center gap-2`} onClick={() => setOpen(true)}>
        <Plus size={17} strokeWidth={2.6} /> New session
      </button>
      {hostRsvpError && <ErrorMessage message={hostRsvpError}/>}
      {open && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) setOpen(false) }}>
        <section role="dialog" aria-modal="true" aria-labelledby="new-session-title" className="w-full max-w-xl overflow-y-auto rounded-3xl border border-white/15 bg-[#17201c] p-6 text-white shadow-2xl max-h-[90vh] sm:p-8">
          <div className="mb-6 flex items-start justify-between gap-4">
            <div><p className="mb-1 text-xs font-bold uppercase tracking-[0.18em] text-[#d7fc83]">Make it happen</p><h2 id="new-session-title" className="text-2xl font-bold tracking-tight">Create a session</h2></div>
            <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="rounded-full p-2 text-white/65 hover:bg-white/10"><X size={22}/></button>
          </div>
          <button type="button" onClick={fillExample} className="mb-5 rounded-xl border border-[#d7fc83]/50 px-4 py-2 text-xs font-bold text-[#d7fc83] hover:bg-[#d7fc83]/10">Fill sample session</button>
          <form onSubmit={e => void submit(e)} className="space-y-4">
            <label className="block text-xs font-medium text-white/75">Format<select className={`${field} mt-1.5`} value={format} onChange={e => setFormat(e.target.value as SessionFormat)}>{SESSION_FORMATS.map(option => <option key={option}>{option}</option>)}</select></label>
            <label className="block text-xs font-medium text-white/75">Session title<input required maxLength={72} className={`${field} mt-1.5`} placeholder="Sunday doubles & rallies" value={title} onChange={e => setTitle(e.target.value)}/></label>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="block text-xs font-medium text-white/75">Court<input required maxLength={100} className={`${field} mt-1.5`} placeholder="Schenley Park" value={court} onChange={e => setCourt(e.target.value)}/></label>
              <label className="block text-xs font-medium text-white/75">Area<input required maxLength={100} className={`${field} mt-1.5`} placeholder="Pittsburgh, PA" value={location} onChange={e => setLocation(e.target.value)}/></label>
            </div>
            <label className="block text-xs font-medium text-white/75">Date & local time<input required type="datetime-local" className={`${field} mt-1.5`} value={startsAt} onChange={e => setStartsAt(e.target.value)}/></label>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <label className="block text-xs font-medium text-white/75">Duration<select className={`${field} mt-1.5`} value={durationMinutes} onChange={e => setDurationMinutes(Number(e.target.value))}>{[60,90,120,150].map(n=><option key={n} value={n}>{n} minutes</option>)}</select></label>
              <label className="block text-xs font-medium text-white/75">Target players<select className={`${field} mt-1.5`} value={targetPlayers} onChange={e=>setTargetPlayers(Number(e.target.value))}>{Array.from({length:11},(_,i)=>i+2).map(n=><option key={n} value={n}>{n} players</option>)}</select></label>
              <label className="block text-xs font-medium text-white/75">Level<select className={`${field} mt-1.5`} value={level} onChange={e=>setLevel(e.target.value as Level)}>{(['All levels','Beginner','Intermediate','Advanced'] as Level[]).map(n=><option key={n}>{n}</option>)}</select></label>
            </div>
            <label className="block text-xs font-medium text-white/75">Maximum confirmed players
              <select className={`${field} mt-1.5`} value={capacity ?? ''} onChange={event => setCapacity(event.target.value ? Number(event.target.value) : undefined)}>
                <option value="">No limit</option>
                {Array.from({ length: 11 }, (_, index) => index + 2).map(size => <option key={size} value={size}>{size} players</option>)}
              </select>
            </label>
            <label className="block text-xs font-medium text-white/75">Notes (optional)<textarea maxLength={400} rows={3} className={`${field} mt-1.5 resize-none`} placeholder="Bring fresh balls. We'll warm up for 15 minutes." value={notes} onChange={e=>setNotes(e.target.value)}/></label>
            <div className="rounded-xl bg-white/5 px-3 py-2 text-xs text-white/60">The target is a planning goal. A maximum limits confirmed RSVPs and stays fixed after publishing. Session details and chat are visible to signed-in members.</div>
            <ErrorMessage message={error}/>
            <button type="submit" disabled={pending || !ready} className={`${accent} w-full`}>{pending ? 'Creating…' : 'Publish session'}</button>
          </form>
        </section>
      </div>}
    </>
  )
}

function ChatPanel({ channelId, sessionId, userId }: { channelId: string; sessionId: string; userId: string }) {
  const { messages, status: messagesStatus, error: messagesError } = useMessages(channelId)
  const { createConfirmed: sendMessage, ready: canSend } = useMutations<Message>('messages')
  const { peers, connected } = usePresenceRoom(`rally:${sessionId}`)
  const { getName } = useUserLookup()
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const msg = draft.trim()
    if (!msg || msg.length > 500 || pending || !canSend || messagesStatus !== 'ready') return
    setPending(true)
    setSendError(null)
    try {
      await sendMessage({ channelId, content: msg, authorId: userId, edited: false })
      setDraft('')
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : 'Message could not be sent.')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex h-[420px] flex-col">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-bold text-white"><MessageCircle size={17} className="text-[#d7fc83]"/> Session chat</h3>
        <span className="flex items-center gap-1.5 text-xs text-white/50"><span className={`h-1.5 w-1.5 rounded-full ${connected?'bg-[#d7fc83]':'bg-white/30'}`}/>{connected ? `${peers.length + 1} here now` : 'Connecting'}</span>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto rounded-2xl border border-white/10 bg-[#0d1411] p-4" aria-live="polite">
        {messages.length === 0 && <div className="grid h-full place-items-center text-center text-sm text-white/45"><div><MessageCircle size={25} className="mx-auto mb-3 opacity-60"/>Start the conversation.<br/>Coordinate arrival and warm-ups.</div></div>}
        {messages.map(message => <div key={message.recordId} className="rounded-xl bg-white/5 p-3">
          <div className="mb-1.5 flex items-center justify-between gap-2"><span className="text-xs font-bold text-[#d7fc83]">{getName(message.data.authorId) ?? 'Player'}</span><span className="text-[11px] text-white/40">{new Date(message.createdAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}</span></div>
          <p className="break-words text-sm leading-relaxed text-white/85">{message.data.deleted ? 'Message deleted' : message.data.content}</p>
        </div>)}
      </div>
      <form onSubmit={e => void submit(e)} className="mt-3 flex gap-2"><input aria-label="Your message" maxLength={500} value={draft} onChange={e=>setDraft(e.target.value)} placeholder="Say something to the group…" className={`${field} min-w-0 flex-1`}/><button type="submit" aria-label="Send message" className={`${accent} flex shrink-0 items-center`} disabled={!draft.trim() || pending || !canSend || messagesStatus !== 'ready'}><Send size={17}/></button></form>
      <ErrorMessage message={sendError || (messagesStatus === 'error' ? (messagesError ?? 'Chat could not load.') : null)} />
      <p className="mt-2 text-[11px] text-white/40">Public channel within this app; do not share sensitive information.</p>
    </div>
  )
}

function SessionDetail({ session, sessionId, userId, sessionRsvps, rsvpStatus, rsvpError }: {
  session: RallySession
  sessionId: string
  userId: string
  sessionRsvps: {recordId: string; data: RallyRSVP}[]
  rsvpStatus: 'loading' | 'ready' | 'error'
  rsvpError?: string
}) {
  const { getName } = useUserLookup()
  const { removeConfirmed, ready: rsvpReady } = useMutations<RallyRSVP>('rsvps')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const people = sessionRsvps
  const myRSVP = people.find(r => r.data.userId === userId)
  const {going, maybe} = summarizeAttendance(people.map(r=>r.data), sessionId)
  const cancelled = session.status === 'cancelled'
  const full = session.capacity != null && going >= session.capacity
  const canChangeRsvp = rsvpStatus === 'ready' && rsvpReady && !busy && !cancelled

  const calendarEvent = !cancelled && (session.hostId === userId || myRSVP?.data.status === 'going')
    ? buildCalendarEvent(session, buildSessionUrl(window.location.origin, sessionId))
    : null

  async function shareSession() {
    try {
      await navigator.clipboard.writeText(buildSessionUrl(window.location.origin, sessionId))
      setCopyState('copied')
    } catch {
      setCopyState('error')
    }
  }

  async function respond(status: RSVPStatus | null) {
    if (!canChangeRsvp) return
    setBusy(true); setError(null)
    try {
      if (!status && myRSVP) await removeConfirmed(myRSVP.recordId)
      else if (status) await runRallyCommand({ operation: 'rsvp', sessionId, status })
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'RSVP did not save.') }
    finally { setBusy(false) }
  }
  async function cancelSession() {
    if (busy || !window.confirm('Cancel this session for everyone?')) return
    setBusy(true); setError(null)
    try { await runRallyCommand({ operation: 'cancel', sessionId }) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not cancel.') }
    finally { setBusy(false) }
  }

  return <div className={`${surface} overflow-hidden`}>
    <div className="relative overflow-hidden bg-[#243529] px-6 pb-7 pt-8 sm:px-8">
      <div aria-hidden className="absolute -right-8 -top-6 h-44 w-44 rounded-full border-[18px] border-[#d7fc83]/15"/>
      <div className="relative">
        <div className="mb-5 flex items-center justify-between gap-3"><span className="inline-flex items-center gap-1.5 rounded-full bg-[#d7fc83]/15 px-3 py-1 text-xs font-bold uppercase tracking-wider text-[#d7fc83]"><Radio size={12}/> {cancelled?'Cancelled':'Session details'}</span><span className="text-xs text-white/65">{[session.format, session.level].filter(Boolean).join(' · ')}</span></div>
        <button type="button" onClick={() => void shareSession()} className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/25 bg-black/15 px-3 py-2 text-xs font-semibold text-white hover:border-[#d7fc83]"><Share2 size={14}/>{copyState === 'copied' ? 'Link copied!' : 'Share this session'}{copyState === 'copied' && <Copy size={13}/>}</button>
        {calendarEvent && (
          <a download="rallycircle-session.ics" href={`data:text/calendar;charset=utf-8,${encodeURIComponent(calendarEvent)}`} className="mb-4 ml-2 inline-flex items-center gap-2 rounded-full border border-white/25 px-3 py-2 text-xs font-semibold text-white hover:border-[#d7fc83]">
            <CalendarDays size={14} aria-hidden /> Add to calendar
          </a>
        )}
        {copyState === 'error'  && <p role="alert" className="mb-3 text-xs text-rose-200">Copy failed. You can copy this page’s URL instead.</p>}
        <h2 className="max-w-lg text-3xl font-black tracking-tight text-white sm:text-4xl">{session.title}</h2>
        <div className="mt-5 grid gap-3 text-sm text-white/80 sm:grid-cols-2">
          <div className="flex items-center gap-2"><CalendarDays size={16} className="text-[#d7fc83]"/>{formatSessionTime(session.startsAt)}</div>
          <div className="flex items-center gap-2"><Clock3 size={16} className="text-[#d7fc83]"/>{session.durationMinutes} minutes</div>
          <div className="flex items-center gap-2"><MapPin size={16} className="text-[#d7fc83]"/>{session.court} · {session.location}</div>
          <div className="flex items-center gap-2"><Users size={16} className="text-[#d7fc83]"/>{going} going · target {session.targetPlayers}{session.capacity != null && ` · max ${session.capacity}`}</div>
        </div>
      </div>
    </div>
    <div className="space-y-6 p-6 sm:p-8">
      <ReadinessPanel confirmed={going} target={session.targetPlayers} status={rsvpStatus} error={rsvpError} cancelled={cancelled} full={full} format={session.format} />
      <section>
        <div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-bold text-white">Who's playing</h3><span className="text-xs text-white/45">{going} confirmed · {maybe} maybe</span></div>
        <div className="flex flex-wrap gap-2">{people.filter(p=>p.data.status==='going').map(r=><span key={r.recordId} className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/80"><span className="mr-1.5 text-[#d7fc83]">●</span>{getName(r.data.userId) ?? 'Player'}</span>)}{going===0&&<p className="text-sm text-white/50">No confirmations yet. Be the first!</p>}</div>
        <p className="mt-3 text-xs text-white/50">Hosted by {getName(session.hostId) ?? 'a community player'}.{session.capacity == null && ' Extra players can still join after the target is reached.'}</p>
        {session.notes && <p className="mt-4 rounded-xl bg-white/5 p-4 text-sm leading-relaxed text-white/70">{session.notes}</p>}
      </section>
      {cancelled ? <p className="rounded-xl bg-rose-500/10 p-4 text-sm font-medium text-rose-300">This session was cancelled by its organizer.</p> : <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!canChangeRsvp || (full && myRSVP?.data.status !== 'going')} onClick={()=>void respond('going')} className={`${myRSVP?.data.status==='going'?accent:'rounded-xl border border-[#d7fc83]/50 px-4 py-3 text-sm font-bold text-[#d7fc83] hover:bg-[#d7fc83]/10'} inline-flex items-center gap-2 disabled:opacity-50`}><Check size={16}/>{busy ? 'Saving…' : myRSVP?.data.status==='going'?'Going ✓':'I’m in'}</button>
        <button type="button" disabled={!canChangeRsvp} onClick={()=>void respond('maybe')} className="rounded-xl border border-white/15 px-4 py-3 text-sm font-semibold text-white/85 hover:bg-white/10 disabled:opacity-50">{myRSVP?.data.status==='maybe'?'Maybe ✓':'Maybe'}</button>
        {myRSVP&&<button type="button" disabled={!canChangeRsvp} onClick={()=>void respond(null)} className="rounded-xl px-3 py-3 text-sm text-white/50 hover:bg-white/10 hover:text-white">Withdraw</button>}
      </div>}
      {!cancelled&&session.hostId===userId&&<button type="button" disabled={busy} onClick={()=>void cancelSession()} className="text-xs text-rose-300/75 underline underline-offset-4 hover:text-rose-200">Cancel my session</button>}
      <ErrorMessage message={error}/>
      <RallyScoreboard
        userId={userId}
        session={session}
        sessionId={sessionId}
        isHost={session.hostId === userId}
        players={people.filter(record => record.data.status === 'going').map(record => ({
          id: record.data.userId,
          name: getName(record.data.userId) ?? 'Player',
        }))}
        nameOf={id => getName(id) ?? 'Player'}
      />
      <LiveCourtboard
        sessionId={sessionId}
        userId={userId}
        hostId={session.hostId}
        sessionStatus={session.status}
        rsvps={people}
        rsvpStatus={rsvpStatus}
        rsvpError={rsvpError}
      />
      <div className="h-px bg-white/10"/>
      {session.chatChannelId ? <ChatPanel channelId={session.chatChannelId} sessionId={sessionId} userId={userId}/> : <div className="rounded-2xl bg-white/5 p-5 text-sm text-white/60"><MessageCircle className="mb-2" size={20}/>Chat is not available for this session. RSVPs still work.</div>}
    </div>
  </div>
}

export default function RalliesPage() {
  const { userId } = useAuth()
  const { records: sessions, status: sessionStatus, error: sessionsError } = useQuery<RallySession>('sessions', {orderBy:'startsAt',orderDir:'asc'})
  const { records: rsvps, status: rsvpStatus, error: rsvpError } = useQuery<RallyRSVP>('rsvps')
  const [searchParams, setSearchParams] = useSearchParams()
  const activeId = searchParams.get('session')
  const selectedCourt = findCourt(searchParams.get('court'))
  function chooseSession(id: string | null) {
    setSearchParams(current => {
      const next = new URLSearchParams(current)
      if (id) {
        next.set('session', id)
        next.delete('court')
      }
      else next.delete('session')
      return next
    }, { replace: true })
  }
  const [view, setView] = useState<'upcoming'|'all'|'mine'|'playing'>('upcoming')
  const now = Date.now()
  const rsvpsBySession = useMemo(() => groupSessionRsvps(rsvps), [rsvps])
  const upcoming = sessions.filter(s => Date.parse(s.data.startsAt) > now && s.data.status === 'open')
  const listings = view === 'upcoming' ? upcoming : sessions.filter(({ recordId, data }) => {
    if (view === 'all') return true
    if (view === 'playing') {
      return data.status === 'open' && readMatchScore(data.matchScore)?.winner === null
    }
    return data.hostId === userId || rsvpsBySession.get(recordId)?.some(rsvp => rsvp.data.userId === userId)
  })
  const selected = activeId ? sessions.find(s => s.recordId === activeId) : listings[0]
  const signedInId = userId ?? ''

  return <div className="min-h-[calc(100vh-64px)] bg-[#0b110f] text-white">
    <div className="mx-auto max-w-7xl px-5 pb-20 pt-10 sm:px-8 lg:pt-16">
      <div className="mb-10 flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
        <div className="max-w-3xl">
          <div className="mb-4 flex items-center gap-2 text-xs font-extrabold uppercase tracking-[0.25em] text-[#d7fc83]"><span className="h-2 w-2 rounded-full bg-[#d7fc83]"/>RallyCircle · community courts</div>
          <h1 className="text-4xl font-black leading-[1.05] tracking-[-0.045em] sm:text-5xl lg:text-6xl">Better tennis starts <span className="text-[#d7fc83]">together.</span></h1>
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-white/55">One place to plan a hit, find your people and show up ready. No group-chat chaos.</p>
        </div>
        <CreateSession userId={signedInId} onCreated={chooseSession} selectedCourt={selectedCourt}/>
      </div>
      <div className="mb-8 grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-white/10 bg-[#15201a] px-5 py-4"><p className="mb-1 text-xs font-medium text-white/50">Upcoming sessions</p><strong className="text-3xl font-black text-[#d7fc83]">{upcoming.length}</strong></div>
        <div className="rounded-2xl border border-white/10 bg-[#15201a] px-5 py-4"><p className="mb-1 text-xs font-medium text-white/50">Community RSVPs</p><strong className="text-3xl font-black">{rsvps.filter(r=>r.data.status==='going').length}</strong></div>
        <div className="rounded-2xl border border-white/10 bg-[#15201a] px-5 py-4"><p className="mb-1 text-xs font-medium text-white/50">Built for real players</p><p className="mt-2 flex items-center gap-2 text-sm font-semibold text-white/80"><ShieldCheck size={17} className="text-[#d7fc83]"/>Real-time. No refresh.</p></div>
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(300px,.85fr)_minmax(440px,1.15fr)]">
        <section aria-labelledby="sessions-heading" className={`${surface} p-5 sm:p-6 ${activeId ? "order-2 lg:order-first" : ""}`}>
          <div className="mb-5 flex items-center justify-between gap-2"><h2 id="sessions-heading" className="text-lg font-bold">Find a rally</h2><span className="text-xs text-white/40">Choose a session</span></div>
          <div className="mb-5 flex flex-wrap gap-2">{(['upcoming','all','mine','playing'] as const).map(tab=><button key={tab} type="button" aria-pressed={view === tab} onClick={()=>{setView(tab);chooseSession(null)}} className={`rounded-full px-3.5 py-2 text-xs font-bold capitalize transition ${view===tab?'bg-[#d7fc83] text-[#0e180f]':'bg-white/5 text-white/55 hover:bg-white/10'}`}>{tab === 'mine' ? 'My sessions' : tab === 'playing' ? 'Playing now' : tab}</button>)}</div>
          {sessionStatus==='loading'||rsvpStatus==='loading'?<div role="status" className="space-y-3"><span className="sr-only">Loading sessions and responses…</span>{[1,2,3].map(n=><div key={n} className="h-32 motion-safe:animate-pulse rounded-2xl bg-white/5"/>)}</div>:sessionStatus==='error'||rsvpStatus==='error'?<ErrorMessage message={sessionStatus==='error'?(sessionsError??'Sessions could not load.'): (rsvpError??'Player confirmations could not load. Refresh to try again.')}/>:listings.length===0?<div className="rounded-2xl border border-dashed border-white/20 p-10 text-center"><Sparkles size={28} className="mx-auto mb-3 text-[#d7fc83]"/><p className="text-sm font-bold">{view === 'playing' ? 'No matches in progress' : 'No sessions here yet'}</p><p className="mt-2 text-xs leading-relaxed text-white/50">{view === 'playing' ? 'Matches appear here when a host starts scoring.' : 'Create a session and invite your hitting partners to join.'}</p></div>:<div className="space-y-3">{listings.map(s=>{
            const going = rsvpsBySession.get(s.recordId)?.filter(rsvp => rsvp.data.status === 'going').length ?? 0
            const chosen=selected?.recordId===s.recordId
            return <button type="button" key={s.recordId} onClick={()=>chooseSession(s.recordId)} aria-pressed={chosen} className={`w-full rounded-2xl border p-4 text-left transition ${chosen?'border-[#d7fc83]/70 bg-[#d7fc83]/10':'border-white/10 bg-white/3 hover:border-white/25 hover:bg-white/7'}`}>
              <div className="mb-3 flex items-center justify-between"><span className="rounded-lg bg-white/10 px-2.5 py-1 text-[11px] font-bold text-white/85">{[s.data.format, s.data.level].filter(Boolean).join(' · ')}</span><ChevronRight size={17} className={chosen?'text-[#d7fc83]':'text-white/30'}/></div>
              <h3 className="text-lg font-extrabold tracking-tight text-white">{s.data.title}</h3>
              <p className="mt-2 flex items-center gap-2 text-xs text-white/60"><CalendarDays size={13}/>{formatSessionTime(s.data.startsAt)}</p>
              <p className="mt-2 flex items-center gap-2 text-xs text-white/60"><MapPin size={13}/>{s.data.court}, {s.data.location}</p>
              <div className="mt-4 flex items-center justify-between border-t border-white/10 pt-3"><span className="flex items-center gap-1.5 text-xs font-semibold text-white/75"><Users size={14} className="text-[#d7fc83]"/>{going} going / target {s.data.targetPlayers}</span><span className={`text-[11px] font-bold ${s.data.status==='cancelled'?'text-rose-300':'text-[#d7fc83]'}`}>{s.data.status==='cancelled'?'Cancelled':s.data.capacity != null && going >= s.data.capacity?'Full':going>=s.data.targetPlayers?'Target reached':'Open to join'}</span></div>
            </button>
          })}</div>}
        </section>
        {activeId && !selected && sessionStatus === "ready" ? <section className={`${surface} p-6`}><h2 className="text-xl font-bold">Session unavailable</h2><p className="mt-2 text-sm text-white/65">Check the shared link or choose another session.</p></section> : selected ? <SessionDetail key={selected.recordId} sessionId={selected.recordId} session={selected.data} userId={signedInId} sessionRsvps={rsvpsBySession.get(selected.recordId) ?? []} rsvpStatus={rsvpStatus} rsvpError={rsvpError}/>:<section className={`${surface} flex min-h-96 flex-col items-center justify-center p-10 text-center`}><div className="mb-5 grid h-20 w-20 place-items-center rounded-full border border-[#d7fc83]/35 bg-[#d7fc83]/10"><Users size={35} className="text-[#d7fc83]"/></div><h2 className="text-2xl font-black">The next match starts here.</h2><p className="mt-3 max-w-sm text-sm leading-relaxed text-white/50">Select an upcoming session or create your own. Every RSVP syncs to the group automatically.</p></section>}
      </div>
      <footer className="mt-12 flex flex-col justify-between gap-3 border-t border-white/10 pt-5 text-xs text-white/40 sm:flex-row"><span>RallyCircle / Made for hitting partners, not bookings</span><span className="flex items-center gap-2"><Radio size={13}/> Powered by DeepSpace auth, records, messaging and presence</span></footer>
    </div>
  </div>
}
