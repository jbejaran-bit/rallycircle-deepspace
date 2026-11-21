import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'
import { rallyCommandAction, schedulingAction } from '../server/rally-command-room.js'
import { notificationsAction } from '../server/notification-actions.js'
import { createRallyAction } from '../server/create-rally-action.js'
import { profileActions } from '../server/profile-actions.js'

export const actions: Record<string, ActionHandler<Env>> = {
  createRally: createRallyAction,
  rallyCommand: rallyCommandAction,
  scheduling: schedulingAction,
  notifications: notificationsAction,
  ...profileActions,
}
