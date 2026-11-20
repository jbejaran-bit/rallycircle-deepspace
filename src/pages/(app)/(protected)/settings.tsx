import { signOut, useUser } from 'deepspace'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui'
import { PlayerIdentity } from '@/components/PlayerIdentity'

export default function SettingsPage() {
  const { user, isLoading, refetch } = useUser()

  return (
    <div className="min-h-full bg-[#101b14] text-white">
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-7 lg:py-12">
        <header>
          <h1 className="text-4xl font-semibold tracking-tight">Account</h1>
          <Link to="/dashboard" className="mt-2 inline-flex min-h-11 items-center text-sm text-[#d7fc83] underline underline-offset-4">Back to dashboard</Link>
        </header>
        <section className="space-y-4 rounded-2xl border border-white/15 bg-[#17251d] p-5" aria-labelledby="account-profile">
          <h2 id="account-profile" className="text-xl font-bold">Player identity</h2>
          {isLoading ? <p role="status">Loading your profile…</p> : user ? (
            <div className="space-y-4">
              <PlayerIdentity name={user.name} imageUrl={user.imageUrl} />
              <dl className="text-sm">
                <dt className="font-semibold">Sign-in email</dt>
                <dd className="break-all text-white/75">{user.email ?? 'Unavailable'}</dd>
              </dl>
              <p className="text-sm text-white/75">Your display name and profile photo identify you to other players in session chat. Your sign-in email is shown here for your account.</p>
            </div>
          ) : <div role="alert"><p>Your profile is unavailable.</p><Button className="mt-3" variant="outline" onClick={() => void refetch().catch(() => undefined)}>Retry profile</Button></div>}
        </section>
        <section className="space-y-3 rounded-2xl border border-white/15 bg-[#17251d] p-5" aria-labelledby="account-session">
          <h2 id="account-session" className="text-xl font-bold">Sign-in and privacy</h2>
          <a className="block min-h-11 text-sm text-[#d7fc83] underline underline-offset-4" href="/privacy">Privacy and help</a>
          <Button variant="secondary" onClick={() => void signOut()}>Sign out</Button>
        </section>
      </div>
    </div>
  )
}
