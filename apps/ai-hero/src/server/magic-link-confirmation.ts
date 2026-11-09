import { createHmac, timingSafeEqual } from 'node:crypto'
import { parse, serialize } from 'cookie'
import { NextRequest } from 'next/server'
import { transferPathOf } from '@/lib/acceptance-link-view'

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
	/** The site's own origin, the only absolute callback it may follow. */
	siteUrl?: string
}

type MagicLinkGetOptions = MagicLinkOptions & {
	/** The email this browser is already signed in as, if any. */
	signedInEmail?: () => Promise<string | null | undefined>
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

const MAGIC_LINK_MAX_BODY_BYTES = 8192

/** Field bounds shared by the cookie payload and the POST body. */
function hasBoundedFields(payload: {
	token?: unknown
	email?: unknown
	callbackUrl?: unknown
}) {
	return (
		typeof payload.token === 'string' &&
		payload.token.length > 0 &&
		payload.token.length <= 2048 &&
		typeof payload.email === 'string' &&
		payload.email.length > 0 &&
		payload.email.length <= 320 &&
		(payload.callbackUrl === null ||
			(typeof payload.callbackUrl === 'string' &&
				payload.callbackUrl.length <= 2048))
	)
}

function isBoundedConfirmation(
	value: unknown,
	now: number,
): value is MagicLinkCookiePayload {
	if (!value || typeof value !== 'object') return false
	const payload = value as Partial<MagicLinkCookiePayload>
	return (
		payload.v === 1 &&
		hasBoundedFields(payload) &&
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
	const providedSignatureText = value.slice(separator + 1)
	const expectedSignatureText = signature(encoded, secret)
	if (providedSignatureText.length !== expectedSignatureText.length) return null
	const providedSignature = Buffer.from(providedSignatureText, 'base64url')
	if (providedSignature.toString('base64url') !== providedSignatureText) return null
	const expectedSignature = Buffer.from(expectedSignatureText, 'base64url')
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

/**
 * A redirect to the confirmation page as a path, which the browser resolves
 * against the address it asked for. Behind a proxy or a tunnel `request.url`
 * carries the server's own host, so an absolute URL built from it sends the
 * browser to `localhost`, away from the origin the cookie was just set on.
 */
function confirmationRedirect(status: 303 | 307) {
	return new Response(null, {
		status,
		headers: {
			location: MAGIC_LINK_CONFIRMATION_PATH,
			'cache-control': 'no-store',
			'referrer-policy': 'no-referrer',
		},
	})
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

/**
 * Where a link may send the browser: a path on this site, never anywhere else.
 * An absolute callback on the site's own origin becomes its path, for the same
 * proxy reason as `confirmationRedirect`.
 */
export function callbackPath(callbackUrl: string | null, siteUrl?: string) {
	if (!callbackUrl) return '/'
	try {
		const site = new URL(siteUrl ?? 'https://site.invalid')
		// Parsed the way a browser would, so a stray tab or backslash cannot
		// turn a path into another host.
		const target = new URL(callbackUrl, site)
		if (target.origin === site.origin)
			return `${target.pathname.replace(/^\/+/, '/')}${target.search}${target.hash}`
	} catch {
		// Not a URL: fall through to the home page.
	}
	return '/'
}

function isSameEmail(a: string | null | undefined, b: string) {
	return Boolean(a) && a!.trim().toLowerCase() === b.trim().toLowerCase()
}

function isMagicLinkCallback(request: Request) {
	return new URL(request.url).pathname === MAGIC_LINK_CALLBACK_PATH
}

/**
 * A link for the account this browser is already signed in as needs no token:
 * it goes straight to where it points. Nothing is consumed or granted, so a
 * second click on a one-time link (a transfer invite, an old login email) lands
 * where it meant to instead of on "this login link expired".
 */
function alreadySignedInRedirect(callbackUrl: string | null, siteUrl?: string) {
	return withSetCookie(
		new Response(null, {
			status: 303,
			headers: {
				location: callbackPath(callbackUrl, siteUrl),
				'cache-control': 'no-store',
				'referrer-policy': 'no-referrer',
			},
		}),
		clearedMagicLinkCookie(),
	)
}

/**
 * LEGACY LINK PATH. Emailed links now carry the token in a URL fragment
 * (`/login/verify#token=...`, see `magic-link-fragment.ts`), which never
 * reaches a server. This GET handler only serves links already sitting in
 * inboxes, whose query string the platform request log has already seen.
 * Remove it, `readConfirmationFromCallback` and the cookie path once the token
 * lifetime (24h, Auth.js Postmark `maxAge`) has passed since the fragment link
 * deployed; GET callbacks then fall through to `authHandler`.
 */
export function createMagicLinkGetHandler<RequestType extends Request>(
	authHandler: AuthHandler<RequestType>,
	options: MagicLinkGetOptions,
) {
	return async function handleMagicLinkGet(request: RequestType) {
		if (!isMagicLinkCallback(request)) return authHandler(request)
		if (request.method === 'HEAD') return new Response(null, { status: 204 })
		if (request.method !== 'GET') return authHandler(request)

		const confirmation = readConfirmationFromCallback(request)
		const response = confirmationRedirect(307)
		if (!confirmation || !options.secret) {
			return withSetCookie(response, clearedMagicLinkCookie())
		}
		if (
			options.signedInEmail &&
			isSameEmail(await options.signedInEmail(), confirmation.email)
		) {
			return alreadySignedInRedirect(confirmation.callbackUrl, options.siteUrl)
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

/**
 * A spent token on a transfer acceptance link lands on the transfer page, which
 * says what is true (still waiting, accepted, canceled, expired), instead of on
 * an expiry error. The token stays spent; only where the browser goes changes.
 */
function spentTokenTransferPath(
	response: Response,
	confirmation: MagicLinkConfirmation,
	siteUrl?: string,
) {
	const location = response.headers.get('location')
	if (!location) return null
	let error: string | null
	try {
		error = new URL(location, 'https://site.invalid').searchParams.get('error')
	} catch {
		return null
	}
	// Auth.js reports a spent or unknown email token as Verification, and some
	// adapter failures on it as Configuration; the person holding the link sees
	// the same thing either way.
	if (error !== 'Verification' && error !== 'Configuration') return null
	return transferPathOf(
		callbackPath(confirmation.callbackUrl, siteUrl).split(/[?#]/, 1)[0]!,
	)
}

type BodyConfirmation =
	| { kind: 'none' }
	| { kind: 'rejected'; status: 400 | 403 }
	| { kind: 'confirmation'; confirmation: MagicLinkConfirmation }

/**
 * The fragment-link flow posts `token`, `email` and `callbackUrl` in the body
 * (urlencoded from the verify page's form, or JSON). A body without a token is
 * the legacy cookie form and falls through. Same-origin only, with the same
 * bounds as the cookie payload.
 */
async function readConfirmationFromBody(
	request: Request,
	options: MagicLinkOptions,
): Promise<BodyConfirmation> {
	const contentType = (request.headers.get('content-type') ?? '').toLowerCase()
	const isJson = contentType.startsWith('application/json')
	const isForm = contentType.startsWith('application/x-www-form-urlencoded')
	if (!isJson && !isForm) return { kind: 'none' }
	const declaredLength = Number(request.headers.get('content-length') ?? 0)
	if (declaredLength > MAGIC_LINK_MAX_BODY_BYTES) {
		return { kind: 'rejected', status: 400 }
	}

	let text: string
	try {
		text = await request.text()
	} catch {
		return { kind: 'rejected', status: 400 }
	}
	if (Buffer.byteLength(text, 'utf8') > MAGIC_LINK_MAX_BODY_BYTES) {
		return { kind: 'rejected', status: 400 }
	}

	let raw: { token?: unknown; email?: unknown; callbackUrl?: unknown }
	if (isJson) {
		try {
			const parsed: unknown = JSON.parse(text)
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				return { kind: 'rejected', status: 400 }
			}
			raw = parsed
		} catch {
			return { kind: 'rejected', status: 400 }
		}
	} else {
		const params = new URLSearchParams(text)
		if (!params.has('token')) return { kind: 'none' }
		raw = {
			token: params.get('token'),
			email: params.get('email'),
			callbackUrl: params.get('callbackUrl') || null,
		}
	}
	if (raw.token === undefined) return { kind: 'none' }

	const expectedOrigin = new URL(options.siteUrl ?? request.url).origin
	if (request.headers.get('origin') !== expectedOrigin) {
		return { kind: 'rejected', status: 403 }
	}

	const candidate = {
		token: raw.token,
		email: raw.email,
		callbackUrl: raw.callbackUrl === undefined ? null : raw.callbackUrl,
	}
	if (!hasBoundedFields(candidate)) return { kind: 'rejected', status: 400 }
	const confirmation = {
		token: candidate.token as string,
		email: candidate.email as string,
		callbackUrl:
			candidate.callbackUrl === null
				? null
				: callbackPath(candidate.callbackUrl as string, expectedOrigin),
	} satisfies MagicLinkConfirmation
	if (
		Buffer.byteLength(JSON.stringify(confirmation), 'utf8') >
		MAGIC_LINK_MAX_PAYLOAD_BYTES
	) {
		return { kind: 'rejected', status: 400 }
	}
	return { kind: 'confirmation', confirmation }
}

export function createMagicLinkConfirmHandler(
	authHandler: AuthHandler<NextRequest>,
	options: MagicLinkOptions,
) {
	return async function handleMagicLinkConfirmation(request: Request) {
		const body = await readConfirmationFromBody(request, options)
		if (body.kind === 'rejected') {
			return new Response(null, {
				status: body.status,
				headers: { 'cache-control': 'no-store' },
			})
		}
		const cookies = parse(request.headers.get('cookie') ?? '')
		const confirmation =
			body.kind === 'confirmation'
				? body.confirmation
				: readMagicLinkCookie(
						cookies[MAGIC_LINK_COOKIE_NAME],
						options.secret,
						options.now,
					)
		if (!confirmation) {
			return withSetCookie(
				confirmationRedirect(303),
				clearedMagicLinkCookie(),
			)
		}

		const response = await authHandler(callbackRequest(request, confirmation))
		const transferPath = spentTokenTransferPath(
			response,
			confirmation,
			options.siteUrl,
		)
		if (transferPath) {
			return withSetCookie(
				new Response(null, {
					status: 303,
					headers: {
						location: `${transferPath}?link=used`,
						'cache-control': 'no-store',
						'referrer-policy': 'no-referrer',
					},
				}),
				clearedMagicLinkCookie(),
			)
		}
		return withSetCookie(response, clearedMagicLinkCookie())
	}
}

export const MAGIC_LINK_CONFIRMATION_FORM_ACTION = MAGIC_LINK_CONFIRM_PATH
