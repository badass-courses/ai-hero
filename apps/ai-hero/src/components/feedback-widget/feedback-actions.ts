'use server'

import { cookies, headers } from 'next/headers'
import { db } from '@/db'
import { users } from '@/db/schema'
import BasicEmail from '@/emails/basic-email'
import { env } from '@/env.mjs'
import { log } from '@/server/logger'
import { redis } from '@/server/redis-client'
import { getServerAuthSession } from '@/server/auth'
import { sendAnEmail } from '@coursebuilder/utils/send-an-email'
import { Ratelimit } from '@upstash/ratelimit'
import { eq } from 'drizzle-orm'
import sanitizeHtml from 'sanitize-html'

import {
	getEmoji,
	type FeedbackContext,
} from '@coursebuilder/ui/feedback-widget'
import {
	FEEDBACK_FAILURE_MESSAGE,
	FEEDBACK_SIGNED_OUT_MESSAGE,
} from './feedback-messages'

export type SendFeedbackFromUserOptions = {
	feedbackText: string
	context?: FeedbackContext
}

export type FeedbackRefusalReason =
	| 'no-session'
	| 'no-user'
	| 'rate-limited'
	| 'send-failed'

export type SendFeedbackResult =
	| { ok: true }
	| { ok: false; reason: FeedbackRefusalReason; message: string }

const feedbackLimiter = new Ratelimit({
	redis,
	prefix: 'feedback-widget',
	limiter: Ratelimit.slidingWindow(5, '10 m'),
})

function refuse(
	reason: FeedbackRefusalReason,
	userId: string | null | undefined,
	message = FEEDBACK_FAILURE_MESSAGE,
	extra: { hadSessionCookie?: boolean } = {},
): SendFeedbackResult {
	// Reason and user id only: never the email or the feedback text.
	void log.warn('feedback.refused', {
		reason,
		userId: userId ?? null,
		...extra,
	})
	return { ok: false, reason, message }
}

/**
 * Sends site feedback to support. The sender is always the signed-in user's
 * own DB row, found by id. A caller-supplied email is never accepted.
 */
export async function sendFeedbackFromUser({
	feedbackText,
	context,
}: SendFeedbackFromUserOptions): Promise<SendFeedbackResult> {
	let userId: string | undefined
	try {
		const { session } = await getServerAuthSession()
		userId = session?.user?.id
		if (!userId) {
			// Presence only, never the value. Same pair proxy.ts checks, matched
			// by prefix because Auth.js chunks large session cookies.
			let hadSessionCookie = false
			try {
				hadSessionCookie = (await cookies())
					.getAll()
					.some(
						({ name }) =>
							name.startsWith('authjs.session-token') ||
							name.startsWith('__Secure-authjs.session-token'),
					)
			} catch {}
			return refuse('no-session', null, FEEDBACK_SIGNED_OUT_MESSAGE, {
				hadSessionCookie,
			})
		}

		const user = await db.query.users.findFirst({
			where: eq(users.id, userId),
		})
		if (!user?.email) return refuse('no-user', userId)

		try {
			const headersList = await headers()
			const ip =
				headersList.get('x-real-ip') ??
				headersList.get('x-forwarded-for')?.split(',')[0]?.trim() ??
				'unknown'
			const verdict = await feedbackLimiter.limit(`user:${userId}`)
			const ipVerdict = await feedbackLimiter.limit(`ip:${ip}`)
			if (!verdict.success || !ipVerdict.success) {
				return refuse('rate-limited', userId)
			}
		} catch (error) {
			// A limiter outage must not stop feedback; log it and carry on.
			void log.error('feedback.rate_limit_failed', {
				userId,
				error: error instanceof Error ? error.message : String(error),
			})
		}

		await sendAnEmail({
			Component: BasicEmail,
			componentProps: {
				body: `${sanitizeHtml(feedbackText)} <br/><br/><i>${
					context?.url ? context.url : ''
				}</i>`,
				messageType: 'transactional',
			},
			Subject: `${
				context?.emotion ? `${getEmoji(context?.emotion).image} ` : ''
			}Feedback from ${user.name ? user.name : user.email} about ${env.NEXT_PUBLIC_SITE_TITLE}`,
			To: env.NEXT_PUBLIC_SUPPORT_EMAIL,
			ReplyTo: user.email,
			type: 'transactional',
		})
		return { ok: true }
	} catch (error) {
		void log.error('feedback.send_failed', {
			userId: userId ?? null,
			error: error instanceof Error ? error.message : String(error),
		})
		return refuse('send-failed', userId)
	}
}
