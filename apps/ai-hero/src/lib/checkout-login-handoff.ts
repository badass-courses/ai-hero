import {
	createHash,
	createHmac,
	randomUUID,
	timingSafeEqual,
} from 'node:crypto'

const HANDOFF_VERSION = 1 as const
const HANDOFF_TTL_MS = 10 * 60 * 1000
const SIGNATURE_DOMAIN = 'ai-hero:checkout-login-handoff:v1:'

export type CheckoutLoginHandoffPayload = {
	version: typeof HANDOFF_VERSION
	country: string
	pppSelected: boolean
	productId: string
	quantity: number
	nonce: string
	issuedAt: number
	expiresAt: number
}

type CheckoutLoginHandoffExpected = Pick<
	CheckoutLoginHandoffPayload,
	'country' | 'productId' | 'quantity'
>

export type CheckoutLoginHandoffVerification =
	| { valid: true; payload: CheckoutLoginHandoffPayload }
	| {
			valid: false
			reason:
				| 'missing'
				| 'missing-secret'
				| 'malformed'
				| 'tampered'
				| 'expired'
				| 'product-mismatch'
				| 'quantity-mismatch'
				| 'country-mismatch'
	  }

type CreateCheckoutLoginHandoffInput = {
	secret: string
	country: string
	pppSelected: boolean
	productId: string
	quantity: number
	nonce?: string
	now?: Date
}

export function createCheckoutLoginHandoffEnvelope({
	secret,
	country,
	pppSelected,
	productId,
	quantity,
	nonce = randomUUID(),
	now = new Date(),
}: CreateCheckoutLoginHandoffInput) {
	if (!secret) throw new Error('checkout-login-handoff-secret-required')

	const issuedAt = now.getTime()
	const payload: CheckoutLoginHandoffPayload = {
		version: HANDOFF_VERSION,
		country,
		pppSelected,
		productId,
		quantity,
		nonce,
		issuedAt,
		expiresAt: issuedAt + HANDOFF_TTL_MS,
	}
	if (!isCheckoutLoginHandoffPayload(payload)) {
		throw new Error('invalid-checkout-login-handoff-payload')
	}

	const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString(
		'base64url',
	)
	return {
		payload,
		token: `${HANDOFF_VERSION}.${encodedPayload}.${sign(encodedPayload, secret)}`,
	}
}

export function createCheckoutLoginHandoff(
	input: CreateCheckoutLoginHandoffInput,
) {
	return createCheckoutLoginHandoffEnvelope(input).token
}

export function hashCheckoutLoginHandoffNonce(nonce: string) {
	return createHash('sha256')
		.update(`ai-hero:checkout-login-handoff-nonce:v1:${nonce}`)
		.digest('hex')
}

export function verifyCheckoutLoginHandoff({
	token,
	secret,
	expected,
	now = new Date(),
}: {
	token?: string | null
	secret?: string
	expected: CheckoutLoginHandoffExpected
	now?: Date
}): CheckoutLoginHandoffVerification {
	if (!token) return { valid: false, reason: 'missing' }
	if (!secret) return { valid: false, reason: 'missing-secret' }

	const [version, encodedPayload, suppliedSignature, extra] = token.split('.')
	if (
		version !== String(HANDOFF_VERSION) ||
		!encodedPayload ||
		!suppliedSignature ||
		extra
	) {
		return { valid: false, reason: 'malformed' }
	}

	if (!constantTimeEqual(suppliedSignature, sign(encodedPayload, secret))) {
		return { valid: false, reason: 'tampered' }
	}

	let payload: unknown
	try {
		payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'))
	} catch {
		return { valid: false, reason: 'malformed' }
	}
	if (!isCheckoutLoginHandoffPayload(payload)) {
		return { valid: false, reason: 'malformed' }
	}

	if (payload.expiresAt <= now.getTime()) {
		return { valid: false, reason: 'expired' }
	}
	if (payload.productId !== expected.productId) {
		return { valid: false, reason: 'product-mismatch' }
	}
	if (payload.quantity !== expected.quantity) {
		return { valid: false, reason: 'quantity-mismatch' }
	}
	if (payload.country !== expected.country) {
		return { valid: false, reason: 'country-mismatch' }
	}

	return { valid: true, payload }
}

function sign(encodedPayload: string, secret: string) {
	return createHmac('sha256', secret)
		.update(`${SIGNATURE_DOMAIN}${encodedPayload}`)
		.digest('base64url')
}

function constantTimeEqual(left: string, right: string) {
	const leftBuffer = Buffer.from(left)
	const rightBuffer = Buffer.from(right)
	return (
		leftBuffer.length === rightBuffer.length &&
		timingSafeEqual(leftBuffer, rightBuffer)
	)
}

function isCheckoutLoginHandoffPayload(
	value: unknown,
): value is CheckoutLoginHandoffPayload {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const payload = value as Record<string, unknown>
	return (
		payload.version === HANDOFF_VERSION &&
		typeof payload.country === 'string' &&
		/^[A-Z]{2}$/.test(payload.country) &&
		typeof payload.pppSelected === 'boolean' &&
		typeof payload.productId === 'string' &&
		payload.productId.length > 0 &&
		Number.isSafeInteger(payload.quantity) &&
		Number(payload.quantity) >= 1 &&
		typeof payload.nonce === 'string' &&
		payload.nonce.length > 0 &&
		Number.isSafeInteger(payload.issuedAt) &&
		Number.isSafeInteger(payload.expiresAt) &&
		Number(payload.expiresAt) - Number(payload.issuedAt) === HANDOFF_TTL_MS
	)
}
