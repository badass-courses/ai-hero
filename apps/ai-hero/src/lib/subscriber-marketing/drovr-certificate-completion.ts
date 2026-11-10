import 'server-only'

import { env } from '@/env.mjs'
import { z } from 'zod'

import { drovrApiKeyForTenant } from './drovr-shadow-emitter'

/** Lesson 7 on each track. drovr runs both tracks in one journey actor. */
export const CERTIFICATE_LESSON_EMAILS = [
	'ai-hero-skills-workflow.email-6',
	'ai-hero-skills-team-workflow.team-email-6',
] as const
export type CertificateLessonEmail = (typeof CERTIFICATE_LESSON_EMAILS)[number]

const deliverySchema = z.object({
	contactId: z.string(),
	journeyId: z.literal('value-path-skills-course'),
	email: z.enum(CERTIFICATE_LESSON_EMAILS),
	status: z.enum(['delivered', 'pending', 'not-routed', 'not-started']),
	provider: z.enum(['postshiba', 'kit']).nullable(),
	route: z.enum(['postshiba', 'kit']).nullable(),
	deliveredAt: z.string().datetime({ offset: true }).nullable(),
})

export type DrovrCertificateCompletion =
	| { status: 'completed'; completedAt: Date }
	| { status: 'not-completed' }
	| { status: 'unavailable' }

/** One tenant-scoped read. Unavailable evidence must never become completion. */
export async function readDrovrCertificateCompletion(
	contactId: string,
	email: CertificateLessonEmail = CERTIFICATE_LESSON_EMAILS[0],
): Promise<DrovrCertificateCompletion> {
	const unavailable = { status: 'unavailable' } as const
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), 2000)
	try {
		const apiKey = drovrApiKeyForTenant('org-aihero')
		if (!env.DROVR_SHADOW_INGEST_URL || !apiKey) return unavailable
		const url = new URL('/email-delivery', env.DROVR_SHADOW_INGEST_URL)
		// Neither a caller-supplied host nor a redirect may receive the bearer.
		if (url.protocol !== 'https:') return unavailable
		url.searchParams.set('contact', contactId)
		url.searchParams.set('email', email)
		const response = await fetch(url, {
			method: 'GET',
			headers: { Authorization: `Bearer ${apiKey}` },
			cache: 'no-store',
			redirect: 'error',
			signal: controller.signal,
		})
		if (!response.ok) return unavailable
		const decoded = deliverySchema.safeParse(await response.json())
		if (
			!decoded.success ||
			decoded.data.contactId !== contactId ||
			decoded.data.email !== email
		) {
			return unavailable
		}
		const delivery = decoded.data
		if (delivery.status !== 'delivered') {
			return delivery.deliveredAt === null && delivery.provider === null
				? { status: 'not-completed' }
				: unavailable
		}
		if (!delivery.provider || !delivery.deliveredAt) return unavailable
		const completedAt = new Date(delivery.deliveredAt)
		if (
			!Number.isFinite(completedAt.getTime()) ||
			completedAt.getTime() > Date.now()
		) {
			return unavailable
		}
		return { status: 'completed', completedAt }
	} catch {
		// Do not log response bodies, contact IDs, or credentials at this boundary.
		return unavailable
	} finally {
		clearTimeout(timeout)
	}
}
