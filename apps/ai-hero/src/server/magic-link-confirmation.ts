const MAGIC_LINK_CALLBACK_PATH = '/api/auth/callback/postmark'
const MAGIC_LINK_CONFIRMATION_PATH = '/login/verify'

type AuthHandler<RequestType extends Request> = (
	request: RequestType,
) => Response | Promise<Response>

type ConfirmationSearchParams = Record<
	string,
	string | string[] | undefined
>

function firstString(value: string | string[] | undefined) {
	return Array.isArray(value) ? value[0] : value
}

function isMagicLinkCallback(request: Request) {
	return new URL(request.url).pathname === MAGIC_LINK_CALLBACK_PATH
}

export function createMagicLinkGetHandler<RequestType extends Request>(
	authHandler: AuthHandler<RequestType>,
) {
	return function handleMagicLinkGet(request: RequestType) {
		if (!isMagicLinkCallback(request)) return authHandler(request)
		if (request.method === 'HEAD') return new Response(null, { status: 204 })
		if (request.method !== 'GET') return authHandler(request)

		const callbackUrl = new URL(request.url)
		if (
			!callbackUrl.searchParams.has('token') ||
			!callbackUrl.searchParams.has('email')
		) {
			return authHandler(request)
		}
		callbackUrl.pathname = MAGIC_LINK_CONFIRMATION_PATH
		return Response.redirect(callbackUrl, 307)
	}
}

export function createMagicLinkCallbackPath(
	searchParams: ConfirmationSearchParams,
) {
	const token = firstString(searchParams.token)
	const email = firstString(searchParams.email)
	if (!token || !email) return null

	const callbackUrl = firstString(searchParams.callbackUrl)
	const query = new URLSearchParams()
	if (callbackUrl) query.set('callbackUrl', callbackUrl)
	query.set('token', token)
	query.set('email', email)
	return `${MAGIC_LINK_CALLBACK_PATH}?${query}`
}
