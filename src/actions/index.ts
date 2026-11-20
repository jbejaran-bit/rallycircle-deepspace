import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'
import { rallyCommandAction } from '../server/rally-command-room.js'
import { extensionActions } from '../server/extensions-actions.js'

export const actions: Record<string, ActionHandler<Env>> = {
  rallyCommand: rallyCommandAction,
  ...extensionActions,
}
