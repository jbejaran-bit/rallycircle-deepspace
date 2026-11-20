import type { CollectionSchema } from 'deepspace/schema'
import {
  CHANNELS_SCHEMA,
  MESSAGES_SCHEMA,
  REACTIONS_SCHEMA,
  CHANNEL_MEMBERS_SCHEMA,
  READ_RECEIPTS_SCHEMA,
} from 'deepspace/schema'
import { usersSchema } from './schemas/users-schema'
import { settingsSchema } from './schemas/admin-schema'
import {
  sessionsSchema,
  rsvpsSchema,
  waitlistsSchema,
  pollsSchema,
  pollVotesSchema,
  notificationsSchema,
  notificationPreferencesSchema,
  recurringSeriesSchema,
} from './schemas/rally-schema'

export const schemas: CollectionSchema[] = [
  usersSchema,
  settingsSchema,
  sessionsSchema,
  rsvpsSchema,
  waitlistsSchema,
  pollsSchema,
  pollVotesSchema,
  notificationsSchema,
  notificationPreferencesSchema,
  recurringSeriesSchema,
  CHANNELS_SCHEMA,
  MESSAGES_SCHEMA,
  REACTIONS_SCHEMA,
  CHANNEL_MEMBERS_SCHEMA,
  READ_RECEIPTS_SCHEMA,
]
