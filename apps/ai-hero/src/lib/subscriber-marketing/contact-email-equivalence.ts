import { createHash } from 'node:crypto'
import {
	CONTACT_EMAIL_KEY_DOMAIN,
	CONTACT_EMAIL_KEY_PREFIX,
} from './contact-email-key-contract'

/** Exact legacy rule. No grammar, Unicode normalization, IDNA or alias policy. */
export const normalizeEmail = (raw: string): string => raw.trim().toLowerCase()
const sha256 = (value: string) =>
	createHash('sha256').update(value, 'utf8').digest('hex')
export const emailEquivalenceKey = (raw: string): string =>
	CONTACT_EMAIL_KEY_PREFIX +
	sha256(JSON.stringify([CONTACT_EMAIL_KEY_DOMAIN, normalizeEmail(raw)]))
export const emailRawSourceDigest = (raw: string): string => sha256(raw)

function wellFormed(value: string): boolean {
	for (const character of value) {
		const point = character.codePointAt(0)
		if (point === undefined || (point >= 0xd800 && point <= 0xdfff))
			return false
	}
	return true
}
function fitsStoredColumn(value: string): boolean {
	return (
		value.length <= 510 && wellFormed(value) && Array.from(value).length <= 255
	)
}
/** Raw varchar(255) uses code points, not JS UTF-16 units. */
export const isStoredEmail = (value: string): boolean =>
	fitsStoredColumn(value) && normalizeEmail(value).length > 0
/** Normalized evidence is not written back to varchar(255). Allow expansion;
 * this conservative resource ceiling is not an address-syntax restriction. */
export function isNormalizedEmail(value: string): boolean {
	if (value.length > 1020 || !wellFormed(value)) return false
	const normalized = normalizeEmail(value)
	return normalized.length > 0 && normalized.length <= 1020
}

/** Use for every raw email INSERT or UPDATE, in the same statement.
 * Non-email updates must not call this helper with a stale snapshot. */
export function contactEmailWriteValues(email: string | null | undefined) {
	if (email == null)
		return { email: null, emailKey: null, emailKeySource: null }
	if (!fitsStoredColumn(email)) throw new Error('Unrepresentable Contact email')
	return {
		email,
		emailKey: emailEquivalenceKey(email),
		emailKeySource: emailRawSourceDigest(email),
	}
}
