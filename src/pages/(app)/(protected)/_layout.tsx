/**
 * Gated routes. Any file under src/pages/(app)/(protected)/ requires sign-in.
 * The `(protected)` folder is a Generouted route group — parentheses mean
 * it doesn't appear in the URL. For a dynamic page that does NOT require
 * sign-in, put it directly under src/pages/(app)/; for a static page, put it
 * at the top level of src/pages/.
 *
 * Children may call data hooks like `useUser()` safely because the parent
 * (app)/_layout.tsx mounts <RecordProvider> above this layout.
 *
 * The `fallback` keeps signed-out visitors inside the app's own chrome
 * (without it, AuthGate shows the SDK's full-screen, non-dismissible
 * overlay). The sign-in overlay opens on demand and can be dismissed.
 */

import { useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { AuthGate } from 'deepspace'
import RallySignIn from '@/components/RallySignIn'
import { Button } from '@/components/ui'

export default function ProtectedLayout() {
  return (
    <AuthGate fallback={<SignedOutPanel />}>
      <Outlet />
    </AuthGate>
  )
}

function SignedOutPanel() {
  const { pathname, search } = useLocation()
  const [showAuthModal, setShowAuthModal] = useState(false)

  const params = new URLSearchParams(search)
  const reason = pathname === '/dashboard' ? 'Sign in to see your sessions, waitlists, and match results.'
    : pathname === '/games' ? 'Sign in to browse rallies and join a game.'
    : pathname === '/courts' ? 'Sign in to explore courts and plan a rally.'
    : pathname === '/series' ? 'Sign in to plan recurring rallies and manage your series.'
    : pathname === '/notifications' ? 'Sign in to see your rally updates.'
    : pathname === '/settings' ? 'Sign in to manage your RallyCircle account and preferences.'
    : pathname === '/rallies' && params.has('session') ? 'Sign in to open this rally invitation.'
    : pathname === '/rallies' && params.get('create') === '1' ? 'Sign in to set a time, choose a court, and invite players.'
    : 'Sign in to access your RallyCircle account.'

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-6 py-20">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card px-6 py-8 text-center sm:px-9">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Sign in to continue</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {reason}
        </p>
        <Button className="mt-6 min-h-11 w-full" onClick={() => setShowAuthModal(true)}>
          Sign in
        </Button>
        <Link
          to="/"
          className="mt-4 inline-flex min-h-11 items-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Back to home
        </Link>
      </div>

      {showAuthModal && <RallySignIn onClose={() => setShowAuthModal(false)} />}
    </div>
  )
}
