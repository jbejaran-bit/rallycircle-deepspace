import { useState } from 'react'
import { resolveCapacity, waitlistPosition, type RallySession, type WaitlistRow } from '@/lib/rally'
import { commandErrorMessage, runRallyCommand } from '@/lib/rally-actions'

/**
 * Capacity and waitlist status for one session. Rendered only for limited
 * sessions — open sessions keep the existing readiness panel alone.
 * All state comes from the live `useQuery('waitlists')` subscription, so a
 * promotion in another browser shows up here without a refresh.
 */
export function CapacityPanel({ session, sessionId, userId, going, waitlists, myStatus, cancelled, highlightWaitlist }: {
  session: RallySession
  sessionId: string
  userId: string
  going: number
  waitlists: WaitlistRow[]
  myStatus: 'going' | 'maybe' | null
  cancelled: boolean
  highlightWaitlist: boolean
}) {
  const capacity = resolveCapacity(session)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!capacity.limited) return null

  const waiting = waitlists.filter(r => r.data.sessionId === sessionId).length
  const position = waitlistPosition(waitlists, sessionId, userId)
  const full = going >= capacity.maxPlayers

  async function join() {
    setBusy(true); setError(null)
    try { await runRallyCommand({ operation: 'joinWaitlist', sessionId }) }
    catch (cause) { setError(commandErrorMessage(cause)) }
    finally { setBusy(false) }
  }

  async function leave() {
    setBusy(true); setError(null)
    try { await runRallyCommand({ operation: 'leaveWaitlist', sessionId }) }
    catch (cause) { setError(commandErrorMessage(cause)) }
    finally { setBusy(false) }
  }

  return (
    <section data-testid="capacity-panel" aria-label="Session capacity" className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm font-bold text-white">
          {going} / {capacity.maxPlayers} spots filled
          {waiting > 0 && <span className="font-semibold text-white/60"> · {waiting} waiting</span>}
        </p>
        <span className={`text-xs font-bold ${full ? 'text-amber-300' : 'text-[#d7fc83]'}`}>
          {cancelled ? 'Waitlist closed' : full ? 'Session full' : `${capacity.maxPlayers - going} ${capacity.maxPlayers - going === 1 ? 'spot' : 'spots'} left`}
        </span>
      </div>
      {cancelled ? (
        <p role="status" className="mt-3 text-sm text-white/60">This session is cancelled; the waitlist is closed and no one will be promoted.</p>
      ) : myStatus === 'going' ? (
        <p role="status" className="mt-3 text-sm text-white/60">You hold a confirmed spot.</p>
      ) : position > 0 ? (
        <div className="mt-3">
          <p role="status" className="text-sm font-semibold text-white">You are #{position} on the waitlist.</p>
          <p className="mt-1 text-xs leading-relaxed text-white/55">If a confirmed player withdraws, the earliest waitlisted player is promoted automatically — no need to keep checking.</p>
          <button type="button" disabled={busy} onClick={() => void leave()} className="mt-3 rounded-xl px-3 py-2 text-sm text-white/60 hover:bg-white/10 hover:text-white disabled:opacity-50">
            {busy ? 'Leaving…' : 'Leave waitlist'}
          </button>
        </div>
      ) : full ? (
        <div className="mt-3">
          <p role="status" className="text-sm font-semibold text-white">This session is full.</p>
          <p className="mt-1 text-xs leading-relaxed text-white/55">
            {highlightWaitlist
              ? 'Your RSVP could not be saved because every spot is taken. Join the waitlist and you will be promoted automatically if a spot opens.'
              : 'Join the waitlist and you will be promoted automatically if a spot opens.'}
          </p>
          <button type="button" disabled={busy} onClick={() => void join()} className="mt-3 rounded-xl bg-[#d7fc83] px-4 py-2.5 text-sm font-bold text-[#101a13] transition hover:bg-[#ebffb8] disabled:opacity-50">
            {busy ? 'Joining…' : 'Join waitlist'}
          </button>
        </div>
      ) : (
        <p role="status" className="mt-3 text-sm text-white/60">Spots are still available — RSVP “I’m in” above to claim one.</p>
      )}
      {error && <p role="alert" className="mt-3 rounded-xl border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-sm text-rose-200">{error}</p>}
    </section>
  )
}
