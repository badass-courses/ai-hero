import { cookies, headers } from 'next/headers'
import { db } from '@/db'
import { contentRead, contentResource, shortlink } from '@/db/schema'
import { getServerAuthSession } from '@/server/auth'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

export const ContentProgressEventSchema = z.object({
	schemaVersion: z.literal(1),
	event: z.literal('content.read'),
	contentId: z.string().min(1).max(255),
	contentType: z.enum([
		'post',
		'lesson',
		'solution',
		'skill-changelog',
		'dictionary',
		'dictionary-entry',
	]),
	contentSlug: z.string().min(1).max(255),
	parentSlug: z.string().min(1).max(255).optional(),
	readSignal: z.enum(['dwell_30s', 'scroll_50', 'cta_click']),
	occurredAt: z.string().datetime(),
	clientEventId: z.string().min(1).max(128),
	pathname: z.string().min(1).max(500),
	kit: z
		.object({
			kitSubscriberId: z.string().min(1).max(255).optional(),
			emailSha256: z
				.string()
				.regex(/^[a-f0-9]{64}$/i)
				.optional(),
		})
		.optional(),
	cta: z
		.object({
			id: z.string().min(1).max(128),
			href: z.string().max(500).optional(),
		})
		.optional(),
})

export type ContentProgressEvent = z.infer<typeof ContentProgressEventSchema>

const SESSION_COOKIE = 'aih_session'
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30

export function normalizeKitSubscriberId(value?: string | null) {
	const trimmed = value?.trim()
	if (!trimmed) return null
	try {
		const parsed = JSON.parse(trimmed) as unknown
		if (typeof parsed === 'string' || typeof parsed === 'number') {
			const normalized = String(parsed).trim()
			return normalized || null
		}
	} catch {
		// Raw URL-param cookies are expected and are already plain strings.
	}
	return trimmed
}

const botPattern =
	/bot|crawl|spider|slurp|preview|facebookexternalhit|slackbot|discordbot|twitterbot|linkedinbot/i

function isBotLikeUserAgent(userAgent: string | null) {
	return !userAgent || botPattern.test(userAgent)
}

function dateBucket(iso: string) {
	return iso.slice(0, 10)
}

function newSessionId() {
	return `aih_${crypto.randomUUID()}`
}

export async function captureContentProgress(input: unknown) {
	const parsed = ContentProgressEventSchema.parse(input)
	const headerStore = await headers()
	const userAgent = headerStore.get('user-agent')

	if (isBotLikeUserAgent(userAgent)) {
		return {
			status: 'ignored' as const,
			reason: 'bot-like-user-agent' as const,
		}
	}

	const cookieStore = await cookies()
	const kitSubscriberId = normalizeKitSubscriberId(
		parsed.kit?.kitSubscriberId ?? cookieStore.get('ck_subscriber_id')?.value,
	)
	const emailSha256 =
		parsed.kit?.emailSha256?.toLowerCase() ??
		cookieStore.get('ck_email_sha256')?.value?.toLowerCase() ??
		null

	if (parsed.kit?.kitSubscriberId) {
		cookieStore.set('ck_subscriber_id', parsed.kit.kitSubscriberId, {
			maxAge: 60 * 60 * 24 * 365,
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: process.env.NODE_ENV === 'production',
		})
	}
	if (emailSha256) {
		cookieStore.set('ck_email_sha256', emailSha256, {
			maxAge: 60 * 60 * 24 * 365,
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: process.env.NODE_ENV === 'production',
		})
	}

	let sessionId = cookieStore.get(SESSION_COOKIE)?.value
	if (!sessionId) {
		sessionId = newSessionId()
		cookieStore.set(SESSION_COOKIE, sessionId, {
			maxAge: SESSION_TTL_SECONDS,
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: process.env.NODE_ENV === 'production',
		})
	}

	const isExternalContent =
		parsed.contentType === 'dictionary' ||
		parsed.contentType === 'dictionary-entry'
	const resource = isExternalContent
		? null
		: await db.query.contentResource.findFirst({
				where: and(
					eq(contentResource.id, parsed.contentId),
					eq(contentResource.type, parsed.contentType),
				),
			})

	if (!isExternalContent && !resource) {
		return { status: 'ignored' as const, reason: 'unknown-content' as const }
	}

	const { session } = await getServerAuthSession()
	const user = session?.user
	const shortlinkSlug = cookieStore.get('sl_ref')?.value ?? null
	const sourceShortlink = shortlinkSlug
		? await db.query.shortlink.findFirst({
				where: eq(shortlink.slug, shortlinkSlug),
			})
		: null
	const firstTouchRaw = cookieStore.get('ft_attr')?.value ?? null
	const semanticIdempotencyKey = [
		'content-read',
		'v1',
		user?.id ?? kitSubscriberId ?? emailSha256 ?? sessionId,
		parsed.contentType,
		parsed.contentId,
		parsed.readSignal,
		dateBucket(parsed.occurredAt),
	]
		.join(':')
		.toLowerCase()

	try {
		await db.insert(contentRead).values({
			sessionId,
			userId: user?.id ?? null,
			kitSubscriberId,
			emailSha256,
			contentId: parsed.contentId,
			contentSlug: parsed.contentSlug,
			contentType: parsed.contentType,
			parentSlug: parsed.parentSlug ?? null,
			readSignal: parsed.readSignal,
			sourceShortlinkSlug: shortlinkSlug,
			shortlinkMetadata: sourceShortlink?.metadata ?? null,
			firstTouch: firstTouchRaw ? safeJsonParse(firstTouchRaw) : null,
			contentMetadata: {
				title:
					resource && typeof resource.fields?.title === 'string'
						? resource.fields.title
						: undefined,
				slug: parsed.contentSlug,
				type: parsed.contentType,
			},
			pathname: parsed.pathname,
			referrer: headerStore.get('referer'),
			userAgent: userAgent?.slice(0, 500) ?? null,
			country: headerStore.get('x-vercel-ip-country'),
			clientEventId: parsed.clientEventId,
			semanticIdempotencyKey,
			occurredAt: new Date(parsed.occurredAt),
		})
	} catch (error) {
		if (error instanceof Error && error.message.includes('Duplicate entry')) {
			return { status: 'deduped' as const, semanticIdempotencyKey }
		}
		throw error
	}

	return { status: 'captured' as const, semanticIdempotencyKey }
}

function safeJsonParse(value: string) {
	try {
		return JSON.parse(value) as Record<string, unknown>
	} catch {
		return null
	}
}
