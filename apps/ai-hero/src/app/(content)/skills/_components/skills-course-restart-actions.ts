'use server'

import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { db } from '@/db'
import BasicEmail from '@/emails/basic-email'
import { env } from '@/env.mjs'
import { resolveEnrolmentIdentity } from '@/lib/enrolment-identity'
import { reconcileAiHeroEmailOptInWithKit } from '@/lib/subscriber-marketing/ai-hero-email-opt-in.server'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import { getValuePathAnswerPages } from '@/lib/subscriber-marketing/value-path-answer-page'
import { buildValuePathEmailPersonalization } from '@/lib/subscriber-marketing/value-path-email-executor'
import {
	SKILLS_WORKFLOW_EMAIL_ZERO,
	SKILLS_WORKFLOW_VALUE_PATH,
} from '@/lib/subscriber-marketing/skills-newsletter-path-entry'
import { SubscriberSchema } from '@/schemas/subscriber'
import { log } from '@/server/logger'
import { sendAnEmail } from '@coursebuilder/utils/send-an-email'

import { SKILLS_HOSTED_RESUBSCRIBE_URL } from './skills-newsletter-config'

type AnswerLink = {
	optionValue?: string
	href: string
}

/** Sends one fresh copy of lesson one without re-enrolling a Kit sequence. */
export async function resendSkillsCourseLessonOne(
	source = 'skills_course_lesson_one_resend',
) {
	const { identity, subscriber } = await resolveEnrolmentIdentity()
	if (!identity) {
		return { success: false as const, reason: 'not-identified' as const }
	}

	try {
		const fromKit = await emailListProvider
			.getSubscriberByEmail(identity.email)
			.catch(() => null)
		const resolvedSubscriber = SubscriberSchema.parse(fromKit ?? subscriber)
		const optIn = await reconcileAiHeroEmailOptInWithKit({
			email: identity.email,
			subscriberState: resolvedSubscriber.state,
		})
		if (optIn.status === 'confirmation-required') {
			return {
				success: false as const,
				reason: 'confirmation-required' as const,
				confirmationUrl: SKILLS_HOSTED_RESUBSCRIBE_URL,
			}
		}

		const repository = new DrizzleCaptureMarketingRepository(db)
		const contact = await repository.findContactByEmail(identity.email)
		const pathTokenSecret =
			process.env.AI_HERO_VALUE_PATH_TOKEN_SECRET ??
			(process.env.NODE_ENV === 'production'
				? null
				: 'dev-value-path-token-secret')
		if (!contact || !pathTokenSecret) {
			throw new Error('Course recovery identity is incomplete')
		}

		const personalization = buildValuePathEmailPersonalization({
			contactId: contact.id,
			kitSubscriberId: String(resolvedSubscriber.id),
			valuePathSlug: SKILLS_WORKFLOW_VALUE_PATH,
			emailResourceId: SKILLS_WORKFLOW_EMAIL_ZERO,
			answerPages: await getValuePathAnswerPages(),
			baseUrl: process.env.NEXT_PUBLIC_URL ?? 'https://www.aihero.dev',
			pathTokenSecret,
		})
		if (!personalization.passed) {
			throw new Error(personalization.reviewReasons.join(', '))
		}

		const fields = personalization.fields as Record<string, string>
		const links = parseAnswerLinks(
			fields.aih_value_path_answer_links_json,
		)
		const personalUrl = answerUrl(links, 'personal')
		const teamUrl = answerUrl(links, 'team')
		const unsureUrl = answerUrl(links, 'unsure')

		const delivery = await sendAnEmail({
			Component: BasicEmail,
			componentProps: {
				preview: 'Choose the AI workflow path that fits your work.',
				messageType: 'transactional' as const,
				body: lessonOneBody({ personalUrl, teamUrl, unsureUrl }),
			},
			Subject: 'Your first AI Skills lesson — sent again',
			To: identity.email,
			ReplyTo: env.NEXT_PUBLIC_SUPPORT_EMAIL,
			From: `${env.NEXT_PUBLIC_SITE_TITLE} <${env.NEXT_PUBLIC_SUPPORT_EMAIL}>`,
			type: 'transactional',
		})
		if (isPostmarkError(delivery)) {
			throw new Error(`Postmark rejected lesson one: ${delivery.ErrorCode}`)
		}

		await log.info('skills.course.lesson_one_resent', {
			subscriberId: resolvedSubscriber.id,
			contactId: contact.id,
			source,
		})
		return { success: true as const }
	} catch (error) {
		await log.error('skills.course.lesson_one_resend_failed', {
			subscriberId: subscriber?.id,
			source,
			error: error instanceof Error ? error.message : String(error),
		})
		return { success: false as const, reason: 'request-failed' as const }
	}
}

function isPostmarkError(value: unknown): value is { ErrorCode: number } {
	return Boolean(
		value &&
			typeof value === 'object' &&
			typeof (value as { ErrorCode?: unknown }).ErrorCode === 'number' &&
			(value as { ErrorCode: number }).ErrorCode !== 0,
	)
}

function parseAnswerLinks(value?: string): AnswerLink[] {
	if (!value) throw new Error('Course recovery links are missing')
	const parsed = JSON.parse(value)
	if (!Array.isArray(parsed))
		throw new Error('Course recovery links are invalid')
	return parsed.filter((link): link is AnswerLink =>
		Boolean(
			link &&
			typeof link === 'object' &&
			typeof link.href === 'string' &&
			(typeof link.optionValue === 'undefined' ||
				typeof link.optionValue === 'string'),
		),
	)
}

function answerUrl(links: AnswerLink[], optionValue: string) {
	const href = links.find((link) => link.optionValue === optionValue)?.href
	if (!href) throw new Error(`Course recovery link is missing: ${optionValue}`)
	return href
}

function lessonOneBody({
	personalUrl,
	teamUrl,
	unsureUrl,
}: {
	personalUrl: string
	teamUrl: string
	unsureUrl: string
}) {
	return `Agents work best when you are not just collecting prompts.

Prompts are disposable. Workflows are reusable.

That is what skills give you: a way to teach your agent how you want work done, then reuse that instruction again and again.

This email course gives you a repeatable workflow for working with agents, not a pile of one-off prompts.

Choose the path that best fits what you are trying to do. Your next email will start with the skill and practice step that matches your goal.

**Choose your path:**

[My Own AI Agent Workflows](${personalUrl})

[Team Agent Workflows](${teamUrl})

[Help me choose the right workflow.](${unsureUrl})

Pick one and I will send the next lesson in a few minutes.`
}
