import { createHmac, timingSafeEqual } from 'node:crypto'

export type ValuePathTokenPayload = {
	contactId: string
	kitSubscriberId?: string
	valuePathResourceId: string
	emailResourceId: string
	sequenceId: string
	expiresAt: string
}

export type ValuePathTokenVerification =
	| { valid: true; payload: ValuePathTokenPayload }
	| { valid: false; reason: 'missing' | 'malformed' | 'tampered' | 'expired' }

export function signValuePathToken(args: {
	payload: ValuePathTokenPayload
	secret: string
}) {
	const encodedPayload = base64UrlEncode(JSON.stringify(args.payload))
	const signature = sign(encodedPayload, args.secret)
	return `${encodedPayload}.${signature}`
}

export function verifyValuePathToken(args: {
	token?: string | null
	secret: string
	now?: Date
}): ValuePathTokenVerification {
	if (!args.token) return { valid: false, reason: 'missing' }
	const [encodedPayload, signature, extra] = args.token.split('.')
	if (!encodedPayload || !signature || extra) {
		return { valid: false, reason: 'malformed' }
	}
	if (!constantTimeEqual(signature, sign(encodedPayload, args.secret))) {
		return { valid: false, reason: 'tampered' }
	}
	try {
		const payload = JSON.parse(base64UrlDecode(encodedPayload))
		if (!isValuePathTokenPayload(payload)) {
			return { valid: false, reason: 'malformed' }
		}
		const now = args.now ?? new Date()
		if (new Date(payload.expiresAt).getTime() <= now.getTime()) {
			return { valid: false, reason: 'expired' }
		}
		return { valid: true, payload }
	} catch {
		return { valid: false, reason: 'malformed' }
	}
}

function sign(encodedPayload: string, secret: string) {
	return createHmac('sha256', secret).update(encodedPayload).digest('base64url')
}

function constantTimeEqual(left: string, right: string) {
	const leftBuffer = Buffer.from(left)
	const rightBuffer = Buffer.from(right)
	return (
		leftBuffer.length === rightBuffer.length &&
		timingSafeEqual(leftBuffer, rightBuffer)
	)
}

function base64UrlEncode(input: string) {
	return Buffer.from(input, 'utf8').toString('base64url')
}

function base64UrlDecode(input: string) {
	return Buffer.from(input, 'base64url').toString('utf8')
}

function isValuePathTokenPayload(
	value: unknown,
): value is ValuePathTokenPayload {
	if (!value || typeof value !== 'object') return false
	const payload = value as Record<string, unknown>
	return (
		typeof payload.contactId === 'string' &&
		(typeof payload.kitSubscriberId === 'undefined' ||
			typeof payload.kitSubscriberId === 'string') &&
		typeof payload.valuePathResourceId === 'string' &&
		typeof payload.emailResourceId === 'string' &&
		typeof payload.sequenceId === 'string' &&
		typeof payload.expiresAt === 'string'
	)
}
