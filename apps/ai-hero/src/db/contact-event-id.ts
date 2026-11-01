import { customAlphabet } from 'nanoid'

/**
 * ContactEvent ids were 5 characters (36^5 ≈ 60M) and collided on PRIMARY at
 * about 0.6% per insert once the table reached ~370k rows. 16 characters on
 * the same alphabet fits the existing varchar(255) column and keeps old ids valid.
 */
export const CONTACT_EVENT_ID_LENGTH = 16

export const contactEventId = customAlphabet(
	'1234567890abcdefghijklmnopqrstuvwxyz',
	CONTACT_EVENT_ID_LENGTH,
)
