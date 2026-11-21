import { useState, type FormEvent } from 'react'
import { signIn } from 'deepspace'
import { ArrowUpRight, CircleDot } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button, Input, Modal } from './ui'

export default function RallySignIn({ onClose }: { onClose: () => void }) {
  const [emailOpen, setEmailOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const fields = new FormData(event.currentTarget)
    setBusy(true)
    setError('')
    try {
      const result = await signIn.email({
        email: String(fields.get('email') ?? '').trim(),
        password: String(fields.get('password') ?? ''),
      })
      if (result.error) {
        setError('Sign-in failed. Check your test account details and try again.')
      } else {
        window.location.reload()
      }
    } catch {
      setError('Sign-in is temporarily unavailable. Try again in a moment.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} size="sm" data-testid="auth-overlay">
      <Modal.Header>
        <CircleDot className="size-8 text-primary" aria-hidden="true" />
        <Modal.Title>Sign in to RallyCircle</Modal.Title>
        <Modal.Description>Continue with your account to join rallies and keep your schedule in one place.</Modal.Description>
      </Modal.Header>
      <div className="mt-4 space-y-2">
        {(['google', 'github'] as const).map(provider => (
          <a key={provider} href={`/api/auth/social-redirect?provider=${provider}`}
            className="flex min-h-11 items-center justify-between rounded-lg border border-border px-3 text-sm font-semibold hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
            Continue with {provider === 'google' ? 'Google' : 'GitHub'} <ArrowUpRight className="size-4" aria-hidden="true" />
          </a>
        ))}
      </div>
      <details className="mt-4 border-t border-border pt-3" open={emailOpen} onToggle={event => setEmailOpen(event.currentTarget.open)}>
        <summary data-testid="auth-email-toggle" className="cursor-pointer py-2 text-sm font-medium text-muted-foreground">Sign in with a test account</summary>
        <form onSubmit={submit} className="mt-2 grid gap-3">
          <label className="grid gap-1 text-sm">Email<Input name="email" type="email" autoComplete="email" required /></label>
          <label className="grid gap-1 text-sm">Password<Input name="password" type="password" autoComplete="current-password" required /></label>
          {error && <p role="alert" className="text-sm">{error}</p>}
          <Button disabled={busy} type="submit" className="min-h-11">{busy ? 'Signing in…' : 'Sign in with email'}</Button>
        </form>
      </details>
      <Link to="/privacy" onClick={onClose} className="mt-4 inline-flex w-fit text-sm text-muted-foreground underline underline-offset-4">Privacy and help</Link>
    </Modal>
  )
}
