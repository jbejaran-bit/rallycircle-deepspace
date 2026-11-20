import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'
import { rallyCommandAction } from '../server/rally-command-room.js'
import { groupAction } from '../server/group-actions.js'
import { tournamentAction } from '../server/tournament-actions.js'

export const actions: Record<string, ActionHandler<Env>> = {
  rallyCommand: rallyCommandAction,
  groups: groupAction,
  tournaments: tournamentAction,
}
