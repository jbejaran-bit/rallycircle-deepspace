import type { Role } from './constants'

export interface NavItem {
  path: string
  label: string
  roles?: Role[]
  devOnly?: boolean
}

export const nav: NavItem[] = [
  { path: '/rallies', label: 'Rallies' },
  { path: '/settings', label: 'Account' },
]
