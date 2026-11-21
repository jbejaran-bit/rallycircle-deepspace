import { useRef, useState } from 'react'
import { runRallyCommand } from '@/lib/rally-actions'
import type { DiscoveryAction } from '@/lib/find-games'

export function DiscoveryRsvp({ sessionId, action }: { sessionId: string; action: DiscoveryAction | null }) {
  const submitting = useRef(false)
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<{ error: boolean; message: string } | null>(null)

  async function submit() {
    if (!action || submitting.current) return
    submitting.current = true
    setPending(true)
    setFeedback(null)
    try {
      await runRallyCommand(action === 'rsvp' ? { operation: 'rsvp', sessionId, status: 'going' } : { operation: 'joinWaitlist', sessionId })
      setFeedback({ error: false, message: action === 'rsvp' ? 'Your RSVP was saved.' : 'Your waitlist request was saved.' })
    } catch (cause) {
      setFeedback({ error: true, message: cause instanceof Error ? cause.message : 'Your response could not be saved. Open the rally to try again.' })
    } finally {
      submitting.current = false
      setPending(false)
    }
  }

  if (!action && !feedback) return null
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-white/10 px-4 py-3">
      {action && (
        <button type="button" className="min-h-11 rounded-lg bg-[#d7fc83] px-4 text-sm font-bold text-[#152015] focus-visible:outline-2 focus-visible:outline-offset-4 disabled:opacity-60" disabled={pending} onClick={() => void submit()}>
          {pending ? 'Saving…' : action === 'rsvp' ? 'RSVP going' : 'Join waitlist'}
        </button>
      )}
      {feedback && <p role={feedback.error ? 'alert' : 'status'} className={feedback.error ? 'text-sm text-rose-200' : 'text-sm text-white/80'}>{feedback.message}</p>}
    </div>
  )
}
