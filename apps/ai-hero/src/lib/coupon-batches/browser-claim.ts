import { NextResponse, type NextRequest } from 'next/server'
import { inSelectorNamespace } from './namespace'

export const COMP_COOKIE = 'aih-c5-comp'
export const COMP_REDEEM_COOKIE = 'aih-c5-comp-redeem'
const cohortPath = /^\/cohorts\/[a-z0-9-]+\/?$/i
const selector = /^c5comp_[0-9a-f]{40}$/i
const privateHeaders = {
	'Cache-Control': 'private, no-store',
	'Referrer-Policy': 'no-referrer',
}
const normalizePath = (path: string) => path.replace(/\/$/, '')

export function parseCompCookie(value: string | undefined) {
	const [path, code, ...extra] = value?.split('~') ?? []
	return path &&
		code &&
		!extra.length &&
		cohortPath.test(path) &&
		selector.test(code)
		? { path, code }
		: null
}

export function compDeliveryRedirect(request: NextRequest) {
	if (request.method !== 'GET' && request.method !== 'HEAD') return
	const url = request.nextUrl.clone()
	const codes = url.searchParams.getAll('code')
	if (!codes.some(inSelectorNamespace)) return
	url.searchParams.delete('code')
	for (const [key, value] of [...url.searchParams]) {
		if (/c5comp_[0-9a-f]{40}/i.test(key + value)) url.searchParams.delete(key)
	}
	const response = NextResponse.redirect(url, {
		status: 303,
		headers: privateHeaders,
	})
	if (
		process.env.AIH_COUPON_BATCH_ENABLED === 'true' &&
		cohortPath.test(url.pathname) &&
		codes.length === 1 &&
		selector.test(codes[0]!)
	) {
		const path = normalizePath(url.pathname)
		const value = `${path}~${codes[0]}`
		const options = {
			httpOnly: true,
			sameSite: 'lax' as const,
			secure: process.env.NODE_ENV === 'production',
			maxAge: 3600,
		}
		response.cookies.set(COMP_COOKIE, value, { ...options, path })
		response.cookies.set(COMP_REDEEM_COOKIE, value, {
			...options,
			path: '/api/coursebuilder/redeem',
		})
	}
	return response
}

export function protectCompPageResponse<T extends Response>(
	request: NextRequest,
	response: T,
): T {
	const value = parseCompCookie(request.cookies.get(COMP_COOKIE)?.value)
	if (value?.path === normalizePath(request.nextUrl.pathname)) {
		for (const [key, header] of Object.entries(privateHeaders))
			response.headers.set(key, header)
	}
	return response
}
