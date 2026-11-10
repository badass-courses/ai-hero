import { LONG_ID_LENGTH, longId } from './long-id'

/** ContactEvent ids collided on PRIMARY as 5 characters; see `long-id.ts`. */
export const CONTACT_EVENT_ID_LENGTH = LONG_ID_LENGTH

export const contactEventId = longId
