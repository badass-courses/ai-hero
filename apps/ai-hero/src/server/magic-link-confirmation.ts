import { createHmac, timingSafeEqual } from 'node:crypto'
import { parse, serialize } from 'cookie'
import { NextRequest } from 'next/server'

const MAGIC_LINK_CALLBACK_PATH = '/api/auth/callback/postmark'
const MAGIC_LINK_CONFIRMATION_PATH = '/login/verify'
const MAGIC_LINK_CONFIRM_PATH = '/api/auth/magic-link/confirm'
const MAGIC_LINK_COOKIE_MAX_AGE_SECONDS = 5 * 60
const MAGIC_LINK_SIGNATURE_DOMAIN = 'aih-magic-link-confirmation:v1:'
const MAGIC_LINK_MAX_PAYLOAD_BYTES = 2600

export const MAGIC_LINK_COOKIE_NAME = '__Host-aih-magic-link-confirmation'

type AuthHandler<RequestType extends Request> = (
	request: RequestType,
) => Response | Promise<Response>

type Clock = number | (() => number)

type MagicLinkCookiePayload = {
	v: 1
	token: string
	email: string
	callbackUrl: string | null
	expiresAt: number
}

export type MagicLinkConfirmation = Pick<
	MagicLinkCookiePayload,
	'token' | 'email' | 'callbackUrl'
>

type MagicLinkOptions = {
	secret: string
	now?: Clock
}

function getNow(clock: Clock | undefined) {
	return typeof clock === 'function' ? clock() : (clock ?? Date.now())
}

function signature(value: string, secret: string) {
	return createHmac('sha256', secret)
		.update(`${MAGIC_LINK_SIGNATURE_DOMAIN}${value}`)
		.digest('base64url')
}

function sealMagicLink(
	confirmation: MagicLinkConfirmation,
	secret: string,
	now: number,
) {
	const payload: MagicLinkCookiePayload = {
		v: 1,
		...confirmation,
		expiresAt: now + MAGIC_LINK_COOKIE_MAX_AGE_SECONDS * 1000,
	}
	const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
	return `${encoded}.${signature(encoded, secret)}`
}

function isBoundedConfirmation(
	value: unknown,
	now: number,
): value is MagicLinkCookiePayload {
	if (!value || typeof value !== 'object') return false
	const payload = value as Partial<MagicLinkCookiePayload>
	return (
		payload.v === 1 &&
		typeof payload.token === 'string' &&
		payload.token.length > 0 &&
		payload.token.length <= 2048 &&
		typeof payload.email === 'string' &&
		payload.email.length > 0 &&
		payload.email.length <= 320 &&
		(payload.callbackUrl === null ||
			(typeof payload.callbackUrl === 'string' &&
				payload.callbackUrl.length <= 2048)) &&
		typeof payload.expiresAt === 'number' &&
		payload.expiresAt > now
	)
}

export function readMagicLinkCookie(
	value: string | undefined,
	secret: string,
	now?: Clock,
): MagicLinkConfirmation | null {
	if (!value || !secret) return null
	const separator = value.lastIndexOf('.')
	if (separator <= 0) return null
	const encoded = value.slice(0, separator)
	const providedSignature = Buffer.from(value.slice(separator + 1), 'base64url')
	const expectedSignature = Buffer.from(signature(encoded, secret), 'base64url')
	if (
		providedSignature.length !== expectedSignature.length ||
		!timingSafeEqual(providedSignature, expectedSignature)
	) {
		return null
	}

	try {
		const payload: unknown = JSON.parse(
			Buffer.from(encoded, 'base64url').toString('utf8'),
		)
		if (!isBoundedConfirmation(payload, getNow(now))) return null
		return {
			token: payload.token,
			email: payload.email,
			callbackUrl: payload.callbackUrl,
		}
	} catch {
		return null
	}
}

function magicLinkCookie(value: string) {
	return serialize(MAGIC_LINK_COOKIE_NAME, value, {
		httpOnly: true,
		secure: true,
		sameSite: 'lax',
		path: '/',
		maxAge: MAGIC_LINK_COOKIE_MAX_AGE_SECONDS,
	})
}

function clearedMagicLinkCookie() {
	return serialize(MAGIC_LINK_COOKIE_NAME, '', {
		httpOnly: true,
		secure: true,
		sameSite: 'lax',
		path: '/',
		maxAge: 0,
		expires: new Date(0),
	})
}

function withSetCookie(response: Response, setCookie: string) {
	const headers = new Headers(response.headers)
	headers.append('set-cookie', setCookie)
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}

function confirmationRedirect(request: Request) {
	const response = Response.redirect(
		new URL(MAGIC_LINK_CONFIRMATION_PATH, request.url),
		307,
	)
	const headers = new Headers(response.headers)
	headers.set('cache-control', 'no-store')
	headers.set('referrer-policy', 'no-referrer')
	return new Response(null, { status: response.status, headers })
}

function readConfirmationFromCallback(request: Request) {
	const url = new URL(request.url)
	const token = url.searchParams.get('token')
	const email = url.searchParams.get('email')
	const callbackUrl = url.searchParams.get('callbackUrl')
	if (!token || token.length > 2048 || !email || email.length > 320) return null
	if (callbackUrl && callbackUrl.length > 2048) return null
	const confirmation = {
		token,
		email,
		callbackUrl,
	} satisfies MagicLinkConfirmation
	if (
		Buffer.byteLength(JSON.stringify(confirmation), 'utf8') >
		MAGIC_LINK_MAX_PAYLOAD_BYTES
	) {
		return null
	}
	return confirmation
}

function isMagicLinkCallback(request: Request) {
	return new URL(request.url).pathname === MAGIC_LINK_CALLBACK_PATH
}

export function createMagicLinkGetHandler<RequestType extends Request>(
	authHandler: AuthHandler<RequestType>,
	options: MagicLinkOptions,
) {
	return function handleMagicLinkGet(request: RequestType) {
		if (!isMagicLinkCallback(request)) return authHandler(request)
		if (request.method === 'HEAD') return new Response(null, { status: 204 })
		if (request.method !== 'GET') return authHandler(request)

		const confirmation = readConfirmationFromCallback(request)
		const response = confirmationRedirect(request)
		if (!confirmation || !options.secret) {
			return withSetCookie(response, clearedMagicLinkCookie())
		}
		return withSetCookie(
			response,
			magicLinkCookie(
				sealMagicLink(confirmation, options.secret, getNow(options.now)),
			),
		)
	}
}

function cookieHeaderWithoutMagicLink(request: Request) {
	const values = parse(request.headers.get('cookie') ?? '')
	delete values[MAGIC_LINK_COOKIE_NAME]
	return Object.entries(values)
		.map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
		.join('; ')
}

function callbackRequest(request: Request, confirmation: MagicLinkConfirmation) {
	const url = new URL(MAGIC_LINK_CALLBACK_PATH, request.url)
	if (confirmation.callbackUrl) {
		url.searchParams.set('callbackUrl', confirmation.callbackUrl)
	}
	url.searchParams.set('token', confirmation.token)
	url.searchParams.set('email', confirmation.email)
	const headers = new Headers(request.headers)
	const remainingCookies = cookieHeaderWithoutMagicLink(request)
	if (remainingCookies) headers.set('cookie', remainingCookies)
	else headers.delete('cookie')
	headers.delete('content-length')
	return new NextRequest(url, { method: 'POST', headers })
}

export function createMagicLinkConfirmHandler(
	authHandler: AuthHandler<NextRequest>,
	options: MagicLinkOptions,
) {
	return async function handleMagicLinkConfirmation(request: Request) {
		const cookies = parse(request.headers.get('cookie') ?? '')
		const confirmation = readMagicLinkCookie(
			cookies[MAGIC_LINK_COOKIE_NAME],
			options.secret,
			options.now,
		)
		if (!confirmation) {
			return withSetCookie(
				Response.redirect(
					new URL(MAGIC_LINK_CONFIRMATION_PATH, request.url),
					303,
				),
				clearedMagicLinkCookie(),
			)
		}

		const response = await authHandler(callbackRequest(request, confirmation))
		return withSetCookie(response, clearedMagicLinkCookie())
	}
}

export const MAGIC_LINK_CONFIRMATION_FORM_ACTION = MAGIC_LINK_CONFIRM_PATH
