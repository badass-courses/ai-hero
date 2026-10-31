import {
	createCipheriv,
	createDecipheriv,
	hkdfSync,
	randomBytes,
} from 'node:crypto'
import { env } from '@/env.mjs'

/**
 * Stateless OAuth values (authorization codes, DCR client ids, consent
 * tickets) are JSON sealed with AES-256-GCM. Each purpose has its own key,
 * derived from the auth secret with HKDF, so a value minted for one purpose
 * never opens as another. No table, no new env var.
 */
export type SealPurpose = 'code' | 'client' | 'consent'

const SALT = 'aihero-learner-oauth'
const IV_BYTES = 12
const TAG_BYTES = 16
/** Sealed values ride in URLs and form fields; refuse anything larger. */
const MAX_SEALED_LENGTH = 8192

function keyFor(purpose: SealPurpose): Buffer | null {
	const secret = env.NEXTAUTH_SECRET
	if (typeof secret !== 'string' || !secret.trim()) return null
	return Buffer.from(hkdfSync('sha256', secret, SALT, `${purpose}:v1`, 32))
}

/** Seals `payload`, or null when the auth secret is missing (fail closed). */
export function seal(purpose: SealPurpose, payload: unknown): string | null {
	const key = keyFor(purpose)
	if (!key) return null
	const iv = randomBytes(IV_BYTES)
	const cipher = createCipheriv('aes-256-gcm', key, iv)
	cipher.setAAD(Buffer.from(purpose))
	const body = Buffer.concat([
		cipher.update(JSON.stringify(payload), 'utf8'),
		cipher.final(),
	])
	return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')
}

/** Opens a sealed value, or null when it is malformed, tampered or foreign. */
export function unseal(purpose: SealPurpose, sealed: unknown): unknown {
	if (
		typeof sealed !== 'string' ||
		sealed.length > MAX_SEALED_LENGTH ||
		!/^[A-Za-z0-9_-]+$/.test(sealed)
	)
		return null
	const key = keyFor(purpose)
	if (!key) return null
	const raw = Buffer.from(sealed, 'base64url')
	if (raw.length <= IV_BYTES + TAG_BYTES) return null
	try {
		const decipher = createDecipheriv(
			'aes-256-gcm',
			key,
			raw.subarray(0, IV_BYTES),
		)
		decipher.setAAD(Buffer.from(purpose))
		decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
		const plain = Buffer.concat([
			decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
			decipher.final(),
		])
		return JSON.parse(plain.toString('utf8')) as unknown
	} catch {
		return null
	}
}

export const nowSeconds = () => Math.floor(Date.now() / 1000)
