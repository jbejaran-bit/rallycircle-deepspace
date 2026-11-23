import { useRef, useState, type FormEvent } from 'react'
import { useMutations } from 'deepspace'
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger, Input } from './ui'
import RallyLocationField from './RallyLocationField'
import { runRallyCommand } from '@/lib/rally-actions'
import { getRallyDetails, validateRallyDetails, type RallyDetailsSnapshot } from '@/lib/rally-place'

type Props = Omit<RallyDetailsSnapshot, 'courtPlace'> & { sessionId: string; courtPlace?: string }

export default function EditRallyDetails({ sessionId, ...current }: Props) {
  const { ready } = useMutations<RallyDetailsSnapshot>('sessions')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const base = useRef(getRallyDetails(current))
  const [draft, setDraft] = useState(base.current)
  const saving = useRef(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving.current || !ready) return
    if (JSON.stringify(base.current) !== JSON.stringify(getRallyDetails(current))) {
      setError('These details changed while you were editing. Close and reopen the form to see the latest version.')
      return
    }
    const details = { ...draft, title: draft.title.trim(), notes: draft.notes.trim(), court: draft.court.trim(), location: draft.location.trim() }
    if (!validateRallyDetails(details)) {
      setError('Check the title, court and area. Choose a valid place or keep a text-only location.')
      return
    }
    saving.current = true
    setBusy(true)
    setError('')
    try {
      await runRallyCommand({ operation: 'editDetails', sessionId, details, expected: base.current })
      setOpen(false)
      setMessage('Rally details saved.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The details could not be saved. Your edits are still here.')
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  return (
    <div className="space-y-1">
      <Dialog open={open} onOpenChange={next => {
        if (saving.current) return
        if (next) {
          base.current = getRallyDetails(current)
          setDraft(base.current)
          setMessage('')
          setError('')
        }
        setOpen(next)
      }}>
        <DialogTrigger className="min-h-11 rounded-md px-2 text-sm underline underline-offset-4">Edit rally details</DialogTrigger>
        <DialogContent className="max-h-[85dvh] overflow-y-auto overscroll-contain sm:max-w-2xl">
          <DialogTitle>Edit rally details</DialogTitle>
          <DialogDescription>Change the title, notes or meeting place participants see.</DialogDescription>
          <form className="space-y-4" onSubmit={event => void submit(event)} aria-busy={busy}>
            <fieldset disabled={busy} className="min-w-0 space-y-4">
              <label className="grid gap-1 text-sm">Session title
                <Input name="title" value={draft.title} onChange={event => setDraft(value => ({ ...value, title: event.target.value }))} maxLength={72} required />
              </label>
              <RallyLocationField court={draft.court} location={draft.location} courtPlace={draft.courtPlace}
                onChange={location => setDraft(value => ({ ...value, ...location }))} disabled={busy} />
              <label className="grid gap-1 text-sm">Notes
                <textarea name="notes" value={draft.notes} onChange={event => setDraft(value => ({ ...value, notes: event.target.value }))} maxLength={400} rows={4}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 focus-visible:outline-2 focus-visible:outline-ring" />
              </label>
              {error && <p role="alert" className="text-sm text-rose-200">{error}</p>}
              <Button type="submit" className="min-h-11" disabled={!ready || busy}>{busy ? 'Saving…' : 'Save details'}</Button>
            </fieldset>
          </form>
        </DialogContent>
      </Dialog>
      <p role="status" className="text-sm">{message}</p>
    </div>
  )
}
