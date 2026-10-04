import { createHmac, timingSafeEqual } from 'node:crypto'

export type InvoiceLinkTokenInput = {
	chargeId: string
	linkVersion: number
	secret: string | undefined
	nowSeconds?: number
}

export const INVOICE_LINK_COOKIE = '__Secure-aihero-invoice-link'

const validVersion = (version: number) =>
	Number.isInteger(version) && version >= 1 && version <= 4294967295

/** Undefined means the default. Invalid configuration must not mint a link. */
export function invoiceLinkTtlDays(value: string | undefined): number {
	if (value === undefined) return 30
	if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
		throw new Error('Invalid invoice link lifetime')
	}
	const days = Number(value)
	if (!Number.isSafeInteger(days * 86400)) {
		throw new Error('Invalid invoice link lifetime')
	}
	return days
}

export function createInvoiceLinkToken({
	chargeId,
	linkVersion,
	secret,
	ttlDays,
	nowSeconds = Math.floor(Date.now() / 1000),
}: InvoiceLinkTokenInput & { ttlDays?: string }): string {
	if (!secret?.trim()) throw new Error('Invoice sharing is not configured')
	const expiresAt = nowSeconds + invoiceLinkTtlDays(ttlDays) * 86400
	if (
		!chargeId ||
		chargeId.includes('|') ||
		!validVersion(linkVersion) ||
		!Number.isSafeInteger(nowSeconds) ||
		!Number.isSafeInteger(expiresAt)
	) {
		throw new Error('Invalid invoice link')
	}
	const signature = createHmac('sha256', secret)
		.update(`${chargeId}|${linkVersion}|${expiresAt}`)
		.digest('base64url')
	return `${linkVersion}.${expiresAt}.${signature}`
}

/** Parse canonical fields, never JavaScript's permissive number syntaxes. */
export function parseInvoiceLinkToken(
	token: unknown,
): { linkVersion: number; expiresAt: number; signature: string } | null {
	if (typeof token !== 'string' || token.length > 96) return null
	const match = /^([1-9]\d*)\.([1-9]\d*)\.([A-Za-z0-9_-]{43})$/.exec(token)
	if (!match) return null
	const version = Number(match[1])
	const expiresAt = Number(match[2])
	const signature = match[3]
	if (!validVersion(version) || !Number.isSafeInteger(expiresAt) || !signature)
		return null
	return { linkVersion: version, expiresAt, signature }
}

/** Compare only fixed-size digest bytes in constant time. */
export function verifyInvoiceLinkToken({
	token,
	chargeId,
	linkVersion,
	secret,
	nowSeconds = Math.floor(Date.now() / 1000),
}: InvoiceLinkTokenInput & { token: unknown }): boolean {
	if (
		!secret?.trim() ||
		!validVersion(linkVersion) ||
		!Number.isSafeInteger(nowSeconds)
	)
		return false
	const parsed = parseInvoiceLinkToken(token)
	if (
		!parsed ||
		parsed.linkVersion !== linkVersion ||
		parsed.expiresAt <= nowSeconds
	)
		return false
	const { signature } = parsed
	const received = Buffer.from(signature, 'base64url')
	// Node's decoder accepts noncanonical trailing bits; reject those too.
	if (received.length !== 32 || received.toString('base64url') !== signature)
		return false
	const expected = createHmac('sha256', secret)
		.update(`${chargeId}|${parsed.linkVersion}|${parsed.expiresAt}`)
		.digest()
	return timingSafeEqual(received, expected)
}
