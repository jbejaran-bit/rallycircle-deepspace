import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'
import { rallyCommandAction, schedulingAction } from '../server/rally-command-room.js'
import { notificationsAction } from '../server/notification-actions.js'

export const actions: Record<string, ActionHandler<Env>> = {
  rallyCommand: rallyCommandAction,
  scheduling: schedulingAction,
  notifications: notificationsAction,
}
