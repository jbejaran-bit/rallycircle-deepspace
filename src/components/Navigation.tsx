/**
 * Top nav — minimal placeholder bar wired to the app's mechanisms:
 * nav.ts-driven links (with role/dev filtering), sign-in via <AuthOverlay>,
 * and sign-out. Restyle or rebuild it freely; keep the data-testid hooks
 * (`app-navigation`, `nav-sign-in-button`, `nav-user-name`, `nav-user-email`)
 * — the shipped tests rely on them. `nav-user-email` is the one that carries
 * an identity the test can check exactly: a display name is optional, the
 * email is the credential the session was opened with.
 */

import { useState, useEffect, useRef } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuthProfileReady, signOut } from 'deepspace'
import { ChevronDown, CircleDot, LogOut, Menu, X } from 'lucide-react'
import RallySignIn from './RallySignIn'
import { APP_NAME } from '../constants'
import type { Role } from '../constants'
import { nav } from '../nav'
import { cn } from '../lib/utils'
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui'

export default function Navigation() {
  const { isLoaded, isSignedIn, user, userLoading } = useAuthProfileReady({ requireUser: true })
  const location = useLocation()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)
  const [showAuthModal, setShowAuthModal] = useState(false)

  const profileReady = !isSignedIn || !userLoading
  const userRole = (user?.role ?? 'anonymous') as Role | 'anonymous'

  // Close the mobile menu when navigating
  useEffect(() => {
    setMobileMenuOpen(false)
  }, [location.pathname, location.search])

  const visibleNav = nav.filter((item) => {
    if (item.devOnly && !import.meta.env.DEV) return false
    if (!item.roles) return true
    if (!profileReady) return false
    if (userRole === 'admin') return true
    return item.roles.includes(userRole as Role)
  })

  const navLink = (item: (typeof nav)[number]) => {
    const active = location.pathname === item.path
    return (
      <Link
        key={item.path}
        to={item.path}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'inline-flex min-h-11 items-center rounded-md px-3 py-1.5 text-sm focus-visible:outline-2',
          active ? 'bg-muted font-semibold text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
        )}
      >
        {item.label}
      </Link>
    )
  }

  return (
    <>
      <nav aria-label="Application navigation" data-testid="app-navigation" className="border-b border-border bg-background" onKeyDown={event => {
        if (event.key === 'Escape' && mobileMenuOpen) {
          setMobileMenuOpen(false)
          menuButton.current?.focus()
        }
      }}>
        <div className="mx-auto flex min-h-14 max-w-7xl items-center gap-2 px-4 sm:gap-4">
          <Link to={isSignedIn ? "/dashboard" : "/"} className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md text-base font-extrabold tracking-tight text-foreground focus-visible:outline-2 focus-visible:outline-ring">
            <CircleDot size={18} className="text-primary" aria-hidden="true" />
            {APP_NAME}
          </Link>

          <div className="hidden items-center lg:flex">{visibleNav.map(navLink)}</div>

          <div className="flex-1" />

          {!isLoaded ? null : isSignedIn && !profileReady ? (
            /* Signed in, profile still loading — skeleton pill, never the
               Sign in button (that would offer sign-in to a signed-in user). */
            <div className="flex items-center gap-2 rounded-full border border-border bg-card/60 py-1 pl-1 pr-2.5">
              <div className="h-6 w-6 motion-safe:animate-pulse rounded-full bg-muted" />
              <div className="hidden h-4 w-20 motion-safe:animate-pulse rounded-md bg-muted sm:block" />
            </div>
          ) : isSignedIn && user ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    aria-label="Account menu"
                    className="group flex items-center gap-2 rounded-full border border-border bg-card/60 py-1 pl-1 pr-2.5 text-sm transition-colors hover:bg-card"
                  >
                    <Avatar className="h-6 w-6 ring-1 ring-inset ring-border">
                      <AvatarImage src={user.imageUrl ?? undefined} referrerPolicy="no-referrer" />
                      <AvatarFallback className="text-[11px]">
                        {(user.name?.[0] ?? user.email?.[0] ?? '?').toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <span
                      data-testid="nav-user-name"
                      className="hidden max-w-[140px] truncate text-foreground sm:inline"
                    >
                      {user.name || user.email}
                    </span>
                    <ChevronDown
                      className="h-3.5 w-3.5 text-muted-foreground transition-transform duration-150 group-data-[popup-open]:rotate-180"
                      aria-hidden
                    />
                  </button>
                }
              />
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>
                  <div className="truncate font-medium text-foreground">
                    {user.name || 'Signed in'}
                  </div>
                  <div
                    data-testid="nav-user-email"
                    className="truncate text-xs font-normal text-muted-foreground"
                  >
                    {user.email}
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => signOut()}>
                  <LogOut aria-hidden />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : isSignedIn ? (
            <div className="flex items-center gap-2">
              <Link to="/settings" className="inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground">Account settings</Link>
              <button type="button" aria-label="Sign out" className="inline-flex size-11 items-center justify-center rounded-md text-muted-foreground" onClick={() => void signOut()}><LogOut aria-hidden className="size-4" /></button>
            </div>
          ) : (
            <button
              data-testid="nav-sign-in-button"
              onClick={() => setShowAuthModal(true)}
              className="min-h-11 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Sign in
            </button>
          )}

          <button
            ref={menuButton}
            className="inline-flex h-11 w-11 shrink-0 rounded-md focus-visible:outline-2 items-center justify-center text-muted-foreground hover:text-foreground lg:hidden"
            onClick={() => setMobileMenuOpen((prev) => !prev)}
            aria-label="Toggle menu"
            aria-expanded={mobileMenuOpen}
            aria-controls="mobile-app-links"
          >
            {mobileMenuOpen ? <X className="h-4 w-4" aria-hidden /> : <Menu className="h-4 w-4" aria-hidden />}
          </button>
        </div>

        <div id="mobile-app-links" hidden={!mobileMenuOpen} className="border-t border-border px-2 py-2 lg:hidden">
          <div className="flex flex-col">{visibleNav.map(navLink)}</div>
        </div>
      </nav>

      {showAuthModal && <RallySignIn onClose={() => setShowAuthModal(false)} />}
    </>
  )
}
