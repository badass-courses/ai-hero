import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from 'node:crypto'

export const SELECTOR_PREFIX = 'c5comp_'
export const ROW_PREFIX = 'batch-coupon-'
const SELECTOR = /^c5comp_[0-9a-f]{40}$/i

export const inSelectorNamespace = (value: unknown): value is string =>
	typeof value === 'string' && value.toLowerCase().startsWith(SELECTOR_PREFIX)
export const inRowNamespace = (value: unknown): value is string =>
	typeof value === 'string' && value.toLowerCase().startsWith(ROW_PREFIX)
export const newSelector = () =>
	`${SELECTOR_PREFIX}${randomBytes(20).toString('hex')}`
export const selectorDigest = (code: string) =>
	SELECTOR.test(code)
		? `c5hash_${createHash('sha256').update(code.toLowerCase()).digest('hex')}`
		: null

// The ledger stores authenticated ciphertext, not the bearer. The coupon
// table's unique code index covers its digest. Neither is a valid selector.
const key = (secret: string) =>
	createHash('sha256').update('aih/c5comp/export/v1\0').update(secret).digest()
export function sealSelector(code: string, secret: string, couponRef: string) {
	const iv = randomBytes(12)
	const cipher = createCipheriv('aes-256-gcm', key(secret), iv)
	cipher.setAAD(Buffer.from(couponRef))
	const ciphertext = Buffer.concat([
		cipher.update(code, 'utf8'),
		cipher.final(),
	])
	return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
		'base64url',
	)
}
export function openSelector(
	sealed: string,
	secret: string,
	couponRef: string,
) {
	const buf = Buffer.from(sealed, 'base64url')
	const cipher = createDecipheriv(
		'aes-256-gcm',
		key(secret),
		buf.subarray(0, 12),
	)
	cipher.setAAD(Buffer.from(couponRef))
	cipher.setAuthTag(buf.subarray(12, 28))
	return Buffer.concat([
		cipher.update(buf.subarray(28)),
		cipher.final(),
	]).toString('utf8')
}
