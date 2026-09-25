import { randomUUID } from 'node:crypto'
import { cookies } from 'next/headers'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { POST as courseBuilderPOST } from '@/coursebuilder/course-builder-config'
import { readKitSubscribeFailureCode } from '@/coursebuilder/email-list-provider'
import { db } from '@/db'
import { contact } from '@/db/schema'
import { env } from '@/env.mjs'
import { DROVR_SIGNUP_REQUESTED_EVENT } from '@/inngest/events/drovr'
import {
	SKILLS_NEWSLETTER_SUBSCRIBED_EVENT,
	type SkillsNewsletterSubscribed,
} from '@/inngest/events/skills-newsletter'
import { inngest } from '@/inngest/inngest.server'
import { createShortlinkAttribution } from '@/lib/shortlinks-query'
import { recordSignupAttribution } from '@/lib/signup-attribution'
import { reconcileAiHeroEmailOptInWithKit } from '@/lib/subscriber-marketing/ai-hero-email-opt-in.server'
import {
	AIH_COURSE_ENTRY_EVIDENCE_FIELD,
	deadlineTimeZoneEvidenceFromHeader,
	parseCourseSequenceExhaustionEnabled,
	serializeDeadlineTimeZoneEvidenceForKit,
} from '@/lib/subscriber-marketing/course-sequence-exhaustion'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import {
	buildDrovrSignupRequest,
	DOI_DROVR_FORM_IDS,
	doiAppliesTo,
	parseDrovrDoiConfig,
	resolveDoiSignupContact,
} from '@/lib/subscriber-marketing/drovr-doi-signup'
import { parseOptInAttributionCookie } from '@/lib/subscriber-marketing/opt-in-attribution'
import {
	AIH_OPTIN_ATTRIBUTION_FIELD,
	serializeOptInAttributionForKit,
} from '@/lib/subscriber-marketing/opt-in-attribution-stash'
import { SubscriberSchema, type Subscriber } from '@/schemas/subscriber'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'

/**
 * Custom wrapper for the subscribe-to-list endpoint that adds shortlink attribution tracking
 *
 * This route intercepts newsletter signups and records attribution if the user
 * came from a shortlink (identified by the sl_ref cookie)
 */
const subscribeWithAttribution = async (req: NextRequest) => {
	// Read the request body before passing to coursebuilder
	const body = await req.json()
	const email = body.email

	// drovr-owned double opt-in, when DROVR_DOI_FORMS turns it on for this
	// form (and address, during the canary). Off, this is a no-op and the
	// signup takes Kit's path below exactly as before.
	const kitFormId = Number(body.listId)
	if (
		typeof email === 'string' &&
		doiAppliesTo(parseDrovrDoiConfig(env), kitFormId, email)
	) {
		return await doiSignup(req, body, email.trim(), kitFormId)
	}

	// Clone the request with the body since it can only be read once
	const clonedRequest = new NextRequest(req.url, {
		method: 'POST',
		headers: req.headers,
		body: JSON.stringify(body),
	})

	// Get the original response from coursebuilder
	const response = await courseBuilderPOST(clonedRequest)
	if (response.status !== 200) {
		const failureCode = readKitSubscribeFailureCode(
			await response.clone().text(),
		)
		if (failureCode) {
			await log.warn('kit.subscribe.failed', {
				context: 'coursebuilder-subscribe-route',
				reason: failureCode,
			})
			switch (failureCode) {
				case 'rate-limited':
					return Response.json(
						{ error: 'Subscription is temporarily unavailable' },
						{ status: 429 },
					)
				case 'upstream':
				case 'unresolved':
					return Response.json(
						{ error: 'Subscription could not be confirmed' },
						{ status: 502 },
					)
				case 'rejected':
					return Response.json(
						{ error: 'Subscription was rejected' },
						{ status: 400 },
					)
			}
		}
		return response
	}

	let confirmedSubscriber: Subscriber | undefined
	let confirmedEmail: string | undefined

	if (response.status === 200) {
		try {
			confirmedSubscriber = SubscriberSchema.parse(
				await response.clone().json(),
			)
		} catch {
			await log.warn('kit.subscribe.response_unresolved', {
				context: 'coursebuilder-subscribe-route',
				reason: 'malformed-subscriber',
			})
			return Response.json(
				{ error: 'Subscription could not be confirmed' },
				{ status: 502 },
			)
		}

		const requestedEmail =
			typeof email === 'string' ? email.trim().toLowerCase() : undefined
		const returnedEmail = confirmedSubscriber.email_address
			?.trim()
			.toLowerCase()
		if (!requestedEmail || returnedEmail !== requestedEmail) {
			await log.warn('kit.subscribe.response_unresolved', {
				context: 'coursebuilder-subscribe-route',
				reason: returnedEmail ? 'subscriber-mismatch' : 'missing-email',
			})
			return Response.json(
				{ error: 'Subscription could not be confirmed' },
				{ status: 502 },
			)
		}
		confirmedEmail = confirmedSubscriber.email_address
	}

	// Only track subscriptions after the response body confirms the subscriber.
	if (response.status === 200 && confirmedSubscriber && confirmedEmail) {
		const subscriber = confirmedSubscriber
		const subscriberEmail = confirmedEmail
		const kitSubscriberId: string | number = subscriber.id

		if (Number(body.listId) === 9376133) {
			try {
				const subscribedAt = new Date().toISOString()
				const sequenceExhaustionEnabled = parseCourseSequenceExhaustionEnabled(
					process.env.AIH_COURSE_SEQUENCE_EXHAUSTION_V1_ENABLED,
				)
				const deadlineTimeZoneResult = deadlineTimeZoneEvidenceFromHeader({
					headerValue: req.headers.get('x-vercel-ip-timezone'),
					capturedAt: subscribedAt,
				})
				const deadlineTimeZone =
					sequenceExhaustionEnabled && deadlineTimeZoneResult.ok
						? deadlineTimeZoneResult.value
						: undefined
				const optIn = await reconcileAiHeroEmailOptInWithKit({
					email: subscriberEmail,
					subscriberState: subscriber.state,
				})
				const cookieStore = await cookies()
				const optInAttribution = parseOptInAttributionCookie(
					cookieStore.get('ft_attr')?.value,
				)
				if (optIn.status === 'confirmation-required') {
					// Enrollment happens later, from Kit data, via the confirmation
					// reconciler — this request is the only moment the browser's
					// attribution exists, so stash it on the Kit subscriber now.
					let attributionStashed = false
					const serialized = optInAttribution
						? serializeOptInAttributionForKit(optInAttribution)
						: undefined
					const serializedCourseEntryEvidence = deadlineTimeZone
						? serializeDeadlineTimeZoneEvidenceForKit(deadlineTimeZone)
						: undefined
					if (serialized || serializedCourseEntryEvidence) {
						try {
							const { setConvertkitSubscriberFields } =
								await import('@coursebuilder/core/providers/convertkit')
							await setConvertkitSubscriberFields({
								subscriber: { id: subscriber.id, fields: subscriber.fields },
								fields: {
									...(serialized
										? { [AIH_OPTIN_ATTRIBUTION_FIELD]: serialized }
										: {}),
									...(serializedCourseEntryEvidence
										? {
												[AIH_COURSE_ENTRY_EVIDENCE_FIELD]:
													serializedCourseEntryEvidence,
											}
										: {}),
								},
								convertkitApiSecret: env.CONVERTKIT_API_SECRET,
								convertkitApiKey: env.CONVERTKIT_API_KEY,
							})
							attributionStashed = true
						} catch (stashError) {
							await log.error('skills.newsletter.attribution.stash.failed', {
								formId: 9376133,
								kitSubscriberId: String(subscriber.id),
								error:
									stashError instanceof Error
										? stashError.message
										: String(stashError),
							})
						}
					}
					// optInAttribution rides the log line so a lost Kit write can
					// still be recovered from Axiom by kitSubscriberId.
					await log.info('skills.newsletter.confirmation.required', {
						formId: 9376133,
						kitSubscriberId: String(subscriber.id),
						hasAttribution: Boolean(optInAttribution),
						hasClickId: Boolean(
							optInAttribution?.gclid ||
							optInAttribution?.gbraid ||
							optInAttribution?.wbraid,
						),
						attributionStashed,
						optInAttribution,
					})
				} else {
					const event: SkillsNewsletterSubscribed = {
						name: SKILLS_NEWSLETTER_SUBSCRIBED_EVENT,
						data: {
							kitSubscriberId: String(subscriber.id),
							email: subscriberEmail,
							name: subscriber.first_name ?? undefined,
							formId: 9376133,
							source: body.fields?.source ?? 'aihero_skills_page',
							subscribedAt,
							...(deadlineTimeZone ? { deadlineTimeZone } : {}),
							optInAttribution,
						},
					}
					await inngest.send(event)
				}
			} catch (error) {
				// DO NOT RETHROW. Everything in this block is post-processing: we are
				// already inside `response.status === 200`, so Kit has accepted the
				// signup and the reader IS subscribed. Rethrowing turned that into a
				// 500, the browser's axios call rejected, and the form rendered its
				// default "Something went wrong." — telling someone who had just
				// subscribed that they had not. The obvious next move is to submit
				// again, which fails the same way.
				//
				// Nothing here is load-bearing enough to justify that. Path entry is
				// guaranteed out-of-band by `skills-newsletter-confirmation-reconciler`
				// on `17 * * * *`, which is the same guarantee the subscribe page's own
				// copy leans on ("Kit confirmation is enrollment. The hourly reconciler
				// guarantees path entry"). A missed enqueue costs at most an hour; a
				// false failure costs the subscriber.
				await log.error('skills.newsletter.path-entry.enqueue.failed', {
					formId: 9376133,
					error: error instanceof Error ? error.message : String(error),
					// Which STAGE failed, so the reconciler-vs-parse distinction is
					// visible in Axiom without reproducing it. The message alone did not
					// say whether Kit's body failed to parse or a downstream call threw.
					stage: error instanceof Error ? error.name : 'unknown',
				})
			}
		}

		try {
			const cookieStore = await cookies()
			const ftAttr = cookieStore.get('ft_attr')?.value
			// Lean page-level attribution for every successful subscribe.
			// Must never fail or slow the subscription response.
			recordSignupAttribution({
				email,
				formId: body.listId,
				kitSubscriberId,
				rawCookie: ftAttr,
			}).catch((error) => {
				void log.error('signup.attribution.failed', {
					formId: body.listId != null ? String(body.listId) : undefined,
					error: error instanceof Error ? error.message : String(error),
				})
			})

			// Read the sl_ref cookie to get the shortlink slug
			const shortlinkSlug = cookieStore.get('sl_ref')?.value

			if (shortlinkSlug) {
				// Record attribution asynchronously (don't await to avoid slowing down response)
				createShortlinkAttribution({
					shortlinkSlug,
					email,
					type: 'signup',
				}).catch((error) => {
					void log.error('api.coursebuilder.subscribe.attribution.failed', {
						shortlinkSlug,
						email,
						error: error instanceof Error ? error.message : String(error),
					})
				})
			}
		} catch (error) {
			// Log error but don't fail the subscription
			await log.error('api.coursebuilder.subscribe.attribution.error', {
				email,
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	return response
}

/**
 * A double opt-in signup: no Kit subscribe and no value-path entry. Find or
 * create the contact, hand drovr the signup durably (it sends the
 * confirmation email and births the course on confirmation), and tell the
 * form to show "check your email". A failure answers the same 502 the Kit
 * path uses; it never falls back to Kit, which (with Kit's own double
 * opt-in off at go-live) would subscribe someone who never confirmed.
 */
async function doiSignup(
	req: NextRequest,
	body: { name?: unknown },
	email: string,
	kitFormId: number,
) {
	const drovrFormId = DOI_DROVR_FORM_IDS.get(kitFormId)
	if (!drovrFormId || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		return Response.json({ error: 'Subscription was rejected' }, { status: 400 })
	}
	const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined
	const now = new Date().toISOString()
	const submissionId = randomUUID()
	try {
		const cookieStore = await cookies()
		const optInAttribution = parseOptInAttributionCookie(
			cookieStore.get('ft_attr')?.value,
		)
		const { contactId } = await resolveDoiSignupContact({
			repository: new DrizzleCaptureMarketingRepository(db),
			findContactIdsByEmailKey: async (emailKey) =>
				(
					await db
						.select({ id: contact.id })
						.from(contact)
						.where(eq(contact.emailKey, emailKey))
						.limit(2)
				).map((row) => row.id),
			email,
			name,
			drovrFormId,
			optInAttribution,
			now,
		})
		await inngest.send({
			id: `drovr-signup:${submissionId}`,
			name: DROVR_SIGNUP_REQUESTED_EVENT,
			data: buildDrovrSignupRequest({
				contactId,
				drovrFormId,
				occurredAt: now,
				submissionId,
				page: req.headers.get('referer') ?? 'https://www.aihero.dev/',
			}),
		})
		await log.info('skills.newsletter.doi.requested', {
			formId: kitFormId,
			contactId,
			hasAttribution: Boolean(optInAttribution),
		})
		const shortlinkSlug = cookieStore.get('sl_ref')?.value
		if (shortlinkSlug) {
			createShortlinkAttribution({
				shortlinkSlug,
				email,
				type: 'signup',
			}).catch((error) => {
				void log.error('api.coursebuilder.subscribe.attribution.failed', {
					shortlinkSlug,
					error: error instanceof Error ? error.message : String(error),
				})
			})
		}
	} catch (error) {
		await log.error('skills.newsletter.doi.failed', {
			formId: kitFormId,
			error: error instanceof Error ? error.name : 'unknown',
		})
		return Response.json(
			{ error: 'Subscription could not be confirmed' },
			{ status: 502 },
		)
	}
	// Subscriber-shaped for the form, with no Kit id: nothing is in Kit yet.
	return Response.json({
		email_address: email,
		first_name: name ?? null,
		state: 'awaiting-confirmation',
		fields: {},
	})
}

export const POST = withSkill(subscribeWithAttribution)
