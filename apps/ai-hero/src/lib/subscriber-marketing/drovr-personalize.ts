import { z } from 'zod'

import {
	DOUBLE_OPT_IN_JOURNEY_ID,
	DOUBLE_OPT_IN_RESUBSCRIBE_AFTER_UNSUBSCRIBE,
} from './drovr-list-subscribe'

import { CouponIssuePayload, offerFieldsFor } from './drovr-evergreen-coupon'
import { evergreenSequenceForMessage } from './drovr-evergreen'
import {
	DROVR_EVERGREEN_OFFER_JOURNEY_ID,
	DROVR_SKILLS_COURSE_JOURNEY_ID,
} from './drovr-shadow-emitter'
import { getSkillsWorkflowEmailStep } from './skills-workflow-path'
import type { ValuePathAnswerPageResource } from './value-path-answer-page'
import type { ValuePathLinkAnchorStore } from './value-path-link-anchor'
import {
	anchoredValuePathLinkExpiry,
	buildValuePathEmailPersonalization,
} from './value-path-email-executor'
import type {
	ContactEventRecord,
	ContactRecord,
	ContactState,
	SideEffectIntent,
} from './types'

export const DrovrPersonalizeRequestSchema = z
	.object({
		tenantId: z.string().trim().min(1),
		contactId: z.string().trim().min(1),
		journeyId: z.string().trim().min(1),
		emailKey: z.string().trim().min(1),
		idempotencyKey: z.string().trim().min(1),
		dueAt: z.string().datetime({ offset: true }),
	})
	.strict()
export type DrovrPersonalizeRequest = z.infer<
	typeof DrovrPersonalizeRequestSchema
>

export type DrovrPersonalizeRepository = {
	findContactById(
		id: string,
	): Promise<ContactRecord | undefined> | ContactRecord | undefined
	findCurrentContactState(
		id: string,
	): Promise<ContactState | undefined> | ContactState | undefined
	findContactEventsByType(
		id: string,
		type: string,
	): Promise<ContactEventRecord[]> | ContactEventRecord[]
	findValuePathEmailSideEffectIntentsByContact(
		id: string,
	): Promise<SideEffectIntent[]> | SideEffectIntent[]
	findSideEffectIntentByIdempotencyKey(
		key: string,
	): Promise<SideEffectIntent | undefined> | SideEffectIntent | undefined
}

export type DrovrPersonalizeAnswer = {
	email: string
	firstName: string | null
	variables: Record<string, string>
	sendable: boolean
	reasons: string[]
	flags: string[]
}

/** The double opt-in confirmation email drovr sends (journey double-opt-in). */
export const DOUBLE_OPT_IN_CONFIRM_EMAIL_KEY = 'ai-hero-confirm.email-0'

const DOUBLE_OPT_IN_BLOCKING_REASONS: ReadonlySet<string> = new Set([
	'contact-email-missing',
	'suppressed',
	'bounced',
	'complained',
	'email-resource-missing',
])

/** Reads only, except the idempotent first-issue anchor of an answer link
 * (value-path-link-anchor): with `linkAnchors`, a (contact, email)'s token
 * expires 120 days after its first issue, so every send and every retry gets
 * the same URL until an input changes. Without it the token expires at
 * dueAt + 30 days. Never the wall clock (PostShiba rejects body drift). */
export async function personalizeDrovrIntent(args: {
	repository: DrovrPersonalizeRepository
	request: DrovrPersonalizeRequest
	answerPages: ValuePathAnswerPageResource[]
	pathTokenSecret?: string
	baseUrl: string
	kitSubscriberId?: string
	identityConflict?: boolean
	/** See DOUBLE_OPT_IN_RESUBSCRIBE_AFTER_UNSUBSCRIBE. */
	resubscribeAfterUnsubscribe?: boolean
	linkAnchors?: ValuePathLinkAnchorStore
	warn?: (event: string, fields: Record<string, unknown>) => unknown
}): Promise<DrovrPersonalizeAnswer | undefined> {
	const { repository, request } = args
	const contact = await repository.findContactById(request.contactId)
	if (!contact) return undefined
	const [state, unsubscribed, bounced, complained, priorIntents] =
		await Promise.all([
			repository.findCurrentContactState(contact.id),
			repository.findContactEventsByType(contact.id, 'contact.unsubscribed'),
			repository.findContactEventsByType(contact.id, 'contact.bounced'),
			repository.findContactEventsByType(contact.id, 'contact.complained'),
			repository.findValuePathEmailSideEffectIntentsByContact(contact.id),
		])
	const reasons: string[] = []
	const flags: string[] = []
	if (!state || state.lifecycle === 'stale' || contact.lifecycle === 'stale')
		reasons.push('stale-state')
	if (state?.lifecycle === 'suppressed' || contact.lifecycle === 'suppressed')
		reasons.push('suppressed')
	if (
		unsubscribed.length > 0 ||
		priorIntents.some(
			(row) =>
				row.metadata.unsubscribed === true || providerFlag(row, 'unsubscribed'),
		)
	)
		reasons.push('unsubscribed')
	if (
		bounced.length > 0 ||
		priorIntents.some(
			(row) => row.metadata.bounced === true || providerFlag(row, 'bounced'),
		)
	)
		reasons.push('bounced')
	if (
		complained.length > 0 ||
		priorIntents.some(
			(row) =>
				row.metadata.complained === true || providerFlag(row, 'complained'),
		)
	)
		reasons.push('complained')
	if (args.identityConflict) reasons.push('identity-conflict')
	if (contact.isProvisional) flags.push('contact-provisional')
	if (state?.reviewSignals.includes('support')) reasons.push('support-intent')
	if (state?.reviewSignals.includes('team-sales'))
		reasons.push('team-sales-intent')
	const email = contact.email?.trim().toLowerCase() ?? ''
	if (!email) reasons.push('contact-email-missing')
	let variables: Record<string, string> = {}
	if (request.journeyId === DROVR_SKILLS_COURSE_JOURNEY_ID) {
		const step = getSkillsWorkflowEmailStep(request.emailKey)
		if (!step) reasons.push('email-resource-missing')
		else {
			const linkExpiresAt = await anchoredValuePathLinkExpiry({
				linkAnchors: args.linkAnchors,
				contactId: contact.id,
				kitSubscriberId: args.kitSubscriberId,
				valuePathSlug: step.valuePathSlug,
				emailResourceId: step.emailResourceId,
				answerPages: args.answerPages,
				baseUrl: args.baseUrl,
				pathTokenSecret: args.pathTokenSecret,
				now: request.dueAt,
				warn: args.warn,
			})
			const personalized = buildValuePathEmailPersonalization({
				contactId: contact.id,
				kitSubscriberId: args.kitSubscriberId,
				valuePathSlug: step.valuePathSlug,
				emailResourceId: step.emailResourceId,
				answerPages: args.answerPages,
				baseUrl: args.baseUrl,
				pathTokenSecret: args.pathTokenSecret,
				now: request.dueAt,
				linkExpiresAt,
			})
			if (personalized.passed) variables = personalized.fields
			else reasons.push(...personalized.reviewReasons)
		}
	} else if (request.journeyId === DROVR_EVERGREEN_OFFER_JOURNEY_ID) {
		const sequence = evergreenSequenceForMessage(request.emailKey)
		if (!sequence) reasons.push('email-resource-missing')
		else if (sequence.slot.startsWith('P')) {
			const coupon = await repository.findSideEffectIntentByIdempotencyKey(
				`contact:${contact.id}:evergreen:coupon`,
			)
			const offer = CouponIssuePayload.safeParse(coupon?.metadata.offer)
			const couponId = coupon?.metadata.couponId
			if (
				coupon?.status !== 'completed' ||
				!offer.success ||
				typeof couponId !== 'string' ||
				!couponId
			)
				reasons.push('offer-fields-missing')
			else
				variables = offerFieldsFor({
					couponId,
					payload: offer.data,
					origin: args.baseUrl,
				})
		}
	} else if (request.journeyId === DOUBLE_OPT_IN_JOURNEY_ID) {
		if (request.emailKey !== DOUBLE_OPT_IN_CONFIRM_EMAIL_KEY)
			reasons.push('email-resource-missing')
	} else reasons.push('email-resource-missing')
	// The confirmation email answers the reader's own signup request, so
	// only what makes an address unsendable holds it back. Whether an earlier
	// unsubscribe does is the one open switch (today's Kit double opt-in
	// email reaches such a reader).
	const resubscribe =
		args.resubscribeAfterUnsubscribe ??
		DOUBLE_OPT_IN_RESUBSCRIBE_AFTER_UNSUBSCRIBE
	const blocking =
		request.journeyId === DOUBLE_OPT_IN_JOURNEY_ID
			? reasons.filter(
					(reason) =>
						DOUBLE_OPT_IN_BLOCKING_REASONS.has(reason) ||
						(!resubscribe && reason === 'unsubscribed'),
				)
			: reasons
	return {
		email,
		firstName: contact.name?.trim().split(/\s+/)[0] || null,
		variables: blocking.length ? {} : variables,
		sendable: blocking.length === 0,
		reasons: [...new Set(blocking)],
		flags,
	}
}

function providerFlag(row: SideEffectIntent, flag: string): boolean {
	const result = row.metadata.providerResult
	return (
		typeof result === 'object' &&
		result !== null &&
		(result as Record<string, unknown>)[flag] === true
	)
}
