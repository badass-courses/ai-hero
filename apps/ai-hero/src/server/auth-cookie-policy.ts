import {
	createOAuthCookiePolicy,
	type OAuthCookiePolicy,
} from '@/lib/oauth-link-cookie'

type RequestHeaders = Pick<Headers, 'get'>
type CookiePolicyRequest = Pick<Request, 'headers' | 'url'>

function protocolFromUrl(value: string | null | undefined) {
	if (!value) return null
	try {
		return new URL(value).protocol
	} catch {
		return null
	}
}

function normalizeForwardedProtocol(value: string | null | undefined) {
	const protocol = value?.split(',')[0]?.trim().toLowerCase()
	if (!protocol) return null
	return protocol.endsWith(':') ? protocol : `${protocol}:`
}

export function resolveAuthCookiePolicy({
	authUrl,
	request,
	headers,
}: {
	authUrl?: string | null
	request?: CookiePolicyRequest
	headers?: RequestHeaders
}): OAuthCookiePolicy {
	const configuredProtocol = protocolFromUrl(authUrl)
	const requestHeaders = request?.headers ?? headers
	const forwardedProtocol = normalizeForwardedProtocol(
		requestHeaders?.get('x-forwarded-proto'),
	)
	const requestProtocol = protocolFromUrl(request?.url)
	const protocol =
		configuredProtocol ?? forwardedProtocol ?? requestProtocol ?? 'https:'

	return createOAuthCookiePolicy(protocol === 'https:')
}

export function createRuntimeAuthCookiePolicyResolver({
	getHeaders,
	getAuthUrl,
}: {
	getHeaders: () => RequestHeaders | Promise<RequestHeaders>
	getAuthUrl: () => string | null | undefined
}) {
	return async function getRuntimeAuthCookiePolicy(
		request?: CookiePolicyRequest,
	): Promise<OAuthCookiePolicy> {
		return resolveAuthCookiePolicy({
			authUrl: getAuthUrl(),
			request,
			headers: request ? undefined : await getHeaders(),
		})
	}
}
