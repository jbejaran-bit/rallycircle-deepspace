import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'
import { rallyCommandAction } from '../server/rally-command-room.js'
import { socialActions } from '../server/social-actions.js'

export const actions: Record<string, ActionHandler<Env>> = {
  rallyCommand: rallyCommandAction,
  ...socialActions,
}
