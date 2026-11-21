import { useRef, useState, type FormEvent } from 'react'
import { useMutations } from 'deepspace'
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger, Input } from './ui'

interface Details {
  title: string
  notes: string
}

export default function EditRallyDetails({ sessionId, title, notes }: Details & { sessionId: string }) {
  const { putConfirmed, ready } = useMutations<Details>('sessions')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const base = useRef<Details>({ title, notes })
  const saving = useRef(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving.current || !ready) return
    if (base.current.title !== title || base.current.notes !== notes) {
      setError('These details changed while you were editing. Close and reopen the form to see the latest version.')
      return
    }
    const fields = new FormData(event.currentTarget)
    const next = { title: String(fields.get('title')).trim(), notes: String(fields.get('notes')).trim() }
    if (!next.title || next.title.length > 72 || next.notes.length > 400) {
      setError('Use a title of 1–72 characters and notes of up to 400 characters.')
      return
    }
    saving.current = true
    setBusy(true)
    setError('')
    try {
      await putConfirmed(sessionId, next)
      setOpen(false)
      setMessage('Rally details saved.')
    } catch {
      setError('The details could not be saved. Your edits are still here.')
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
          base.current = { title, notes }
          setMessage('')
          setError('')
        }
        setOpen(next)
      }}>
        <DialogTrigger className="min-h-11 rounded-md px-2 text-sm underline underline-offset-4">Edit rally details</DialogTrigger>
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogTitle>Edit rally details</DialogTitle>
          <DialogDescription>Change the title or notes participants see.</DialogDescription>
          <form className="space-y-4" onSubmit={submit}>
            <label className="grid gap-1 text-sm">Session title
              <Input name="title" defaultValue={base.current.title} maxLength={72} required />
            </label>
            <label className="grid gap-1 text-sm">Notes
              <textarea name="notes" defaultValue={base.current.notes} maxLength={400} rows={4}
                className="w-full rounded-md border border-input bg-background px-3 py-2 focus-visible:outline-2 focus-visible:outline-ring" />
            </label>
            {error && <p role="alert" className="text-sm">{error}</p>}
            <Button type="submit" className="min-h-11" disabled={!ready || busy}>{busy ? 'Saving…' : 'Save details'}</Button>
          </form>
        </DialogContent>
      </Dialog>
      {message && <p role="status" className="text-sm">{message}</p>}
    </div>
  )
}
