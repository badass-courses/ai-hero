import { customAlphabet } from 'nanoid'

/**
 * 5-character ids (36^5 ≈ 60M) collide on PRIMARY once a table holds a few
 * hundred thousand rows. 16 characters on the same alphabet fits the existing
 * varchar(255) id columns and keeps old ids valid.
 */
export const LONG_ID_LENGTH = 16

export const longId = customAlphabet(
	'1234567890abcdefghijklmnopqrstuvwxyz',
	LONG_ID_LENGTH,
)
