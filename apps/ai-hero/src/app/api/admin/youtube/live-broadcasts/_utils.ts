import { NextRequest, NextResponse } from 'next/server'
import { getServerAuthSession } from '@/server/auth'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { log, serializeError } from '@/server/logger'
import type { YouTubeLiveBroadcastStatus } from '@/lib/youtube-live-broadcasts'

// Wildcard CORS is intentional for bearer-token operator clients.
// We do not set Access-Control-Allow-Credentials, so browser session cookies
// are not sent cross-origin. Each handler still enforces admin auth.
export const youtubeLiveCorsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

type AdminAuth = {
	authorized: boolean
	authMethod: 'device_token' | 'session' | 'none'
	user: {
		id?: string | null
		email?: string | null
		name?: string | null
	} | null
}

export async function getYouTubeLiveAdminAuth(
	request: NextRequest,
): Promise<AdminAuth> {
	const deviceAuth = await getUserAbilityForRequest(request)
	if (deviceAuth.user && deviceAuth.ability.can('manage', 'all')) {
		return {
			authorized: true,
			authMethod: 'device_token',
			user: deviceAuth.user,
		}
	}

	const sessionAuth = await getServerAuthSession()
	if (sessionAuth.session?.user && sessionAuth.ability.can('manage', 'all')) {
		return {
			authorized: true,
			authMethod: 'session',
			user: sessionAuth.session.user,
		}
	}

	return {
		authorized: false,
		authMethod: deviceAuth.user ? 'device_token' : 'none',
		user: deviceAuth.user ?? sessionAuth.session?.user ?? null,
	}
}

export function unauthorizedResponse(endpoint: string) {
	return NextResponse.json(
		{
			ok: false,
			endpoint,
			error: { message: 'Unauthorized', code: 'AUTH_REQUIRED' },
			fix: 'Authenticate with an admin session or admin device token.',
		},
		{ status: 401, headers: youtubeLiveCorsHeaders },
	)
}

export function forbiddenResponse(endpoint: string) {
	return NextResponse.json(
		{
			ok: false,
			endpoint,
			error: { message: 'Admin access required', code: 'ADMIN_REQUIRED' },
		},
		{ status: 403, headers: youtubeLiveCorsHeaders },
	)
}

export function validationErrorResponse(endpoint: string, details: unknown) {
	return NextResponse.json(
		{
			ok: false,
			endpoint,
			error: { message: 'Invalid input', code: 'INVALID_INPUT' },
			details,
		},
		{ status: 400, headers: youtubeLiveCorsHeaders },
	)
}

export function notFoundResponse(endpoint: string, id: string) {
	return NextResponse.json(
		{
			ok: false,
			endpoint,
			error: { message: 'YouTube broadcast not found', code: 'NOT_FOUND' },
			id,
		},
		{ status: 404, headers: youtubeLiveCorsHeaders },
	)
}

export function conflictResponse(
	endpoint: string,
	code: string,
	message: string,
) {
	return NextResponse.json(
		{
			ok: false,
			endpoint,
			error: { message, code },
		},
		{ status: 409, headers: youtubeLiveCorsHeaders },
	)
}

export function upstreamErrorResponse(endpoint: string, error: unknown) {
	return NextResponse.json(
		{
			ok: false,
			endpoint,
			error: {
				message: error instanceof Error ? error.message : 'YouTube API failed',
				code: 'YOUTUBE_API_ERROR',
			},
		},
		{ status: 502, headers: youtubeLiveCorsHeaders },
	)
}

export function getBroadcastStatusFromRequest(request: NextRequest) {
	const { searchParams } = new URL(request.url)
	const status = searchParams.get('status') ?? 'upcoming'
	if (!['active', 'all', 'completed', 'upcoming'].includes(status)) {
		return { ok: false as const, status: null, rawStatus: status }
	}
	return {
		ok: true as const,
		status: status as YouTubeLiveBroadcastStatus,
		rawStatus: status,
	}
}

export function getLimitFromRequest(request: NextRequest) {
	const { searchParams } = new URL(request.url)
	const rawLimit = Number(searchParams.get('limit') ?? 50)
	if (!Number.isFinite(rawLimit)) return 50
	return Math.max(1, Math.min(Math.trunc(rawLimit), 50))
}

export function buildTelemetry(
	request: NextRequest,
	auth: AdminAuth,
	extra: Record<string, unknown> = {},
) {
	const url = new URL(request.url)
	return {
		telemetrySchemaVersion: 1,
		surface: 'aihero.youtube.live.admin',
		path: url.pathname,
		query: Object.fromEntries(url.searchParams.entries()),
		method: request.method,
		authMethod: auth.authMethod,
		actorUserId: auth.user?.id ?? null,
		actorEmail: auth.user?.email ?? null,
		actorName: auth.user?.name ?? null,
		userAgent: request.headers.get('user-agent'),
		clientIp:
			request.headers.get('x-forwarded-for') ||
			request.headers.get('x-real-ip'),
		...extra,
	}
}

export function payloadTelemetry(payload: {
	id?: string
	title?: string
	description?: string
	scheduledStartTime?: string | null
	scheduledEndTime?: string | null
	privacyStatus?: string | null
	streamId?: string | null
	watchUrl?: string | null
	lifeCycleStatus?: string | null
	boundStreamId?: string | null
	thumbnailUrl?: string | null
}) {
	return {
		broadcastId: payload.id ?? null,
		broadcastTitle: payload.title ?? null,
		broadcastDescription: payload.description ?? null,
		broadcastDescriptionLength: payload.description?.length ?? null,
		scheduledStartTime: payload.scheduledStartTime ?? null,
		scheduledEndTime: payload.scheduledEndTime ?? null,
		privacyStatus: payload.privacyStatus ?? null,
		streamId: payload.streamId ?? null,
		watchUrl: payload.watchUrl ?? null,
		lifeCycleStatus: payload.lifeCycleStatus ?? null,
		boundStreamId: payload.boundStreamId ?? null,
		thumbnailUrl: payload.thumbnailUrl ?? null,
		hasThumbnailUrl: Boolean(payload.thumbnailUrl),
	}
}

export async function logInfoSafely(
	event: string,
	buildData: () => Record<string, unknown>,
) {
	try {
		await log.info(event, buildData())
	} catch {
		// Telemetry must never change the API response path.
	}
}

export async function flushLogsSafely() {
	try {
		await log.flush()
	} catch {
		// Telemetry must never change the API response path.
	}
}

export async function logFailedOperation(
	event: string,
	request: NextRequest,
	auth: AdminAuth,
	error: unknown,
	extra: Record<string, unknown> = {},
) {
	try {
		await log.error(event, {
			...buildTelemetry(request, auth, extra),
			error: serializeError(error),
		})
		await log.flush()
	} catch {
		// Telemetry must never change the API response path.
	}
}
