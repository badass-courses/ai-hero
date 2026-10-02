import type { CaptureMarketingRepository } from './capture-contact-event'
import type { ContactEventRecord } from './types'
import { normalizeContactEvent } from './normalize-contact-event'
import { parseNewsletterExitFlag } from './newsletter-exit-flags.mjs'

export const OLD_NEWSLETTER_ABSENT = 'newsletter.old-sequence.absent'

export const OLD_NEWSLETTER_ENROLLMENT_REQUESTED =
	'newsletter.old-sequence.enrollment-requested'
export const OLD_NEWSLETTER_SUBSCRIBED = 'newsletter.old-sequence.subscribed'
export const OLD_NEWSLETTER_EXIT_CONFIRMED =
	'newsletter.old-sequence.exit-confirmed'
export const OLD_NEWSLETTER_REFERENCE = 'kit:sequence:2625552'
export const OLD_NEWSLETTER_EXIT_TAG = 'shadow-exit-2625552'
export const NEWSLETTER_EXIT_REQUIRED = 'newsletter.exit-required'
export const NEWSLETTER_ADMISSION_HELD = 'newsletter.admission.held'
export const NEWSLETTER_PROTECTED_COHORT = 'newsletter.shadow.protected-cohort'
export const NEWSLETTER_COHORT_CLEAR = 'newsletter.shadow.cohort-clear'

/** New admissions have an explicit marker; pre-existing readers are exempt
 * until ruling B is satisfied and the operator explicitly enables their gate. */
export async function requiresOldNewsletterExit(args: {
	repository: OldNewsletterRepository
	contactId: string
	existingReader: boolean
}): Promise<boolean> {
	const markers = await args.repository.findContactEventsByType?.(
		args.contactId,
		NEWSLETTER_EXIT_REQUIRED,
	)
	return (
		Boolean(
			markers?.some(
				(event) =>
					event.contactId === args.contactId &&
					event.eventType === NEWSLETTER_EXIT_REQUIRED,
			),
		) ||
		(args.existingReader &&
			parseNewsletterExitFlag(
				process.env.AIH_SHADOW_NEWSLETTER_EXISTING_EXIT_GATE_ENABLED,
			))
	)
}

/** A complete account-owner cohort snapshot must attest clear membership.
 * Missing exclusion data is not permission to tag a pre-gate veteran. */
export async function veteranCohortProtection(
	repository: OldNewsletterRepository,
	contactId: string,
): Promise<'protected' | 'clear' | 'unknown'> {
	if (!repository.findContactEventsByType) return 'unknown'
	const protectedRows = await repository.findContactEventsByType(
		contactId,
		NEWSLETTER_PROTECTED_COHORT,
	)
	if (
		protectedRows.some(
			(event) =>
				event.contactId === contactId &&
				event.eventType === NEWSLETTER_PROTECTED_COHORT,
		)
	)
		return 'protected'
	const clearRows = await repository.findContactEventsByType(
		contactId,
		NEWSLETTER_COHORT_CLEAR,
	)
	return clearRows.some(
		(event) =>
			event.contactId === contactId &&
			event.eventType === NEWSLETTER_COHORT_CLEAR,
	)
		? 'clear'
		: 'unknown'
}

export type OldNewsletterReader = { contactId: string; email: string }
export type OldNewsletterMembership =
	| 'present'
	| 'exited'
	| 'absent'
	| 'unknown'
export type OldNewsletterExitGate = (
	reader: OldNewsletterReader,
) => Promise<void>
export type EndOldSequenceMembership = (
	reader: OldNewsletterReader,
) => Promise<'unsupported' | 'requested'>
export type OldNewsletterRepository = Pick<
	CaptureMarketingRepository,
	'findContactEventsByType'
>

export class OldNewsletterExitRefusedError extends Error {
	readonly retryable = true
	constructor(readonly reason: string) {
		super(`old-newsletter-exit-refused:${reason}`)
		this.name = 'OldNewsletterExitRefusedError'
	}
}

/** A bound exit receipt or explicit app-owned-signup absence fact is proof.
 * Missing history alone and an acknowledged tag write never establish absence. */
export async function readOldSequenceMembership(
	repository: OldNewsletterRepository,
	contactId: string,
): Promise<OldNewsletterMembership> {
	if (!repository.findContactEventsByType) return 'unknown'
	const [subscriptions, requests, exits, absent] = await Promise.all([
		repository.findContactEventsByType(contactId, OLD_NEWSLETTER_SUBSCRIBED),
		repository.findContactEventsByType(
			contactId,
			OLD_NEWSLETTER_ENROLLMENT_REQUESTED,
		),
		repository.findContactEventsByType(
			contactId,
			OLD_NEWSLETTER_EXIT_CONFIRMED,
		),
		repository.findContactEventsByType(contactId, OLD_NEWSLETTER_ABSENT),
	])
	const latest = (events: ContactEventRecord[], type: string): number =>
		events.reduce((time, event) => {
			if (
				event.contactId !== contactId ||
				event.eventType !== type ||
				event.provider !== 'kit' ||
				event.providerReference !== OLD_NEWSLETTER_REFERENCE
			)
				return time
			const occurredAt = Date.parse(event.occurredAt)
			return Number.isFinite(occurredAt) ? Math.max(time, occurredAt) : time
		}, -Infinity)
	const subscribedAt = Math.max(
		latest(subscriptions, OLD_NEWSLETTER_SUBSCRIBED),
		latest(requests, OLD_NEWSLETTER_ENROLLMENT_REQUESTED),
	)
	const malformedEnrollment = [...subscriptions, ...requests].some(
		(event) =>
			event.contactId === contactId &&
			event.provider === 'kit' &&
			event.providerReference === OLD_NEWSLETTER_REFERENCE &&
			!Number.isFinite(Date.parse(event.occurredAt)),
	)
	if (malformedEnrollment) return 'unknown'
	const exitedAt = latest(exits, OLD_NEWSLETTER_EXIT_CONFIRMED)
	const absentAt = latest(
		absent.filter(
			(event) => event.payloadSummary?.source === 'drovr-owned-signup',
		),
		OLD_NEWSLETTER_ABSENT,
	)
	if (exitedAt > subscribedAt) return 'exited'
	if (absentAt > subscribedAt) return 'absent'
	return subscribedAt > -Infinity ? 'present' : 'unknown'
}

/** Record BEFORE a legacy enrollment can run. A failed/ambiguous write is
 * conservatively present too; otherwise an older exit proof could permit sends. */
export async function recordOldNewsletterEnrollmentRequest(args: {
	repository: Pick<
		CaptureMarketingRepository,
		'findProviderIdentity' | 'createContactEvent'
	>
	contactId: string
	kitSubscriberId: string
	email: string
	eventId: string
	now: string
}) {
	const identity = await args.repository.findProviderIdentity(
		'kit',
		args.kitSubscriberId,
	)
	if (!identity || identity.contactId !== args.contactId)
		throw new Error('Old newsletter enrollment identity missing')
	return args.repository.createContactEvent({
		...normalizeContactEvent({
			provider: 'kit',
			externalId: args.kitSubscriberId,
			email: args.email,
			providerEventId: `sequence:2625552:enrollment-requested:${args.eventId}`,
			eventType: OLD_NEWSLETTER_ENROLLMENT_REQUESTED,
			occurredAt: args.now,
			message: 'Old newsletter enrollment requested',
			privacyLevel: 'internal',
		}),
		providerReference: OLD_NEWSLETTER_REFERENCE,
		contactId: args.contactId,
		providerIdentityId: identity.id,
		createdAt: args.now,
	})
}

/** Only the branch that skips all legacy enrollment may attest app absence.
 * Veterans, prior unknown admissions, and any legacy history remain gated. */
export async function recordOldNewsletterSignupAbsence(args: {
	repository: Pick<
		CaptureMarketingRepository,
		'findContactEventsByType' | 'createContactEvent'
	>
	contactId: string
	providerIdentityId: string
	kitSubscriberId: string
	email: string
	now: string
}) {
	const read = args.repository.findContactEventsByType
	if (!read) return
	const types = [
		OLD_NEWSLETTER_SUBSCRIBED,
		OLD_NEWSLETTER_ENROLLMENT_REQUESTED,
		NEWSLETTER_PROTECTED_COHORT,
		NEWSLETTER_COHORT_CLEAR,
	]
	const [histories, markers, signupHistory] = await Promise.all([
		Promise.all(
			types.map((type) => read.call(args.repository, args.contactId, type)),
		),
		read.call(args.repository, args.contactId, NEWSLETTER_EXIT_REQUIRED),
		read.call(args.repository, args.contactId, 'skills-newsletter.subscribed'),
	])
	if (
		histories.some((rows) => rows.length > 0) ||
		signupHistory.some(
			(event) =>
				!Number.isFinite(Date.parse(event.occurredAt)) ||
				Date.parse(event.occurredAt) < Date.parse(args.now),
		) ||
		markers.some(
			(event) => event.payloadSummary?.source !== 'drovr-owned-signup',
		)
	)
		return
	const event = normalizeContactEvent({
		provider: 'kit',
		externalId: args.kitSubscriberId,
		email: args.email,
		providerEventId: `sequence:2625552:absent:drovr-owned-signup:${args.contactId}`,
		eventType: OLD_NEWSLETTER_ABSENT,
		occurredAt: args.now,
		message: 'Legacy newsletter absent at app-owned signup',
		privacyLevel: 'internal',
	})
	return args.repository.createContactEvent({
		...event,
		payloadSummary: { ...event.payloadSummary, source: 'drovr-owned-signup' },
		contactId: args.contactId,
		providerIdentityId: args.providerIdentityId,
		providerReference: OLD_NEWSLETTER_REFERENCE,
		createdAt: args.now,
	})
}

export function createOldNewsletterExitGate(args: {
	repository: OldNewsletterRepository
	/** Admission only. Send/replay checks never request exits for the held cohort. */
	endOldSequenceMembership?: EndOldSequenceMembership
}): OldNewsletterExitGate {
	return async (reader) => {
		const readMembership = async () => {
			try {
				return await readOldSequenceMembership(
					args.repository,
					reader.contactId,
				)
			} catch {
				throw new OldNewsletterExitRefusedError(
					'membership-or-exit-unavailable',
				)
			}
		}
		const membership = await readMembership()
		if (membership === 'exited' || membership === 'absent') return
		// Transport failures from the tag port escape unchanged for Inngest retry.
		if (args.endOldSequenceMembership) {
			const outcome = await args.endOldSequenceMembership(reader)
			if (outcome === 'unsupported')
				throw new OldNewsletterExitRefusedError('exit-rule-pending')
			// A tag acknowledgement is not proof; read the independent receipt.
			if ((await readMembership()) === 'exited') return
		}
		throw new OldNewsletterExitRefusedError(`membership-${membership}`)
	}
}

/** The account owner must verify the NEW tag id and approve/configure the UI
 * rule before enabling this adapter. It never creates tags or configures Kit.
 * No membership scans: the rule completion receipt is still required locally. */
export const endOldSequenceMembership: EndOldSequenceMembership = async (
	reader,
) => {
	const tagId = process.env.KIT_SHADOW_NEWSLETTER_EXIT_TAG_ID?.trim()
	if (
		!parseNewsletterExitFlag(
			process.env.AIH_SHADOW_NEWSLETTER_EXIT_RULE_READY,
		) ||
		!parseNewsletterExitFlag(
			process.env.AIH_SHADOW_NEWSLETTER_EXIT_PRODUCER_READY,
		) ||
		!tagId ||
		!/^[1-9]\d*$/.test(tagId) ||
		['23763332', '22309615'].includes(tagId)
	)
		return 'unsupported'
	const { addSubscriberToKitTag } = await import('./drovr-evergreen')
	await addSubscriberToKitTag({
		apiKey: process.env.KIT_V4_API_KEY,
		fetch,
		tagId,
		email: reader.email,
	})
	return 'requested'
}
