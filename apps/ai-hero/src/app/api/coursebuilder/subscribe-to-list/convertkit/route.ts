import { cookies } from 'next/headers'
import { NextRequest } from 'next/server'
import { POST as courseBuilderPOST } from '@/coursebuilder/course-builder-config'
import { readKitSubscribeFailureCode } from '@/coursebuilder/email-list-provider'
import { env } from '@/env.mjs'
import {
	SKILLS_NEWSLETTER_SUBSCRIBED_EVENT,
	type SkillsNewsletterSubscribed,
} from '@/inngest/events/skills-newsletter'
import { inngest } from '@/inngest/inngest.server'
import {
	interestFieldKeysOf,
	interestKitWritesEnabled,
	waitlistOffKitEnabled,
} from '@/lib/cta/interest-facts'
import {
	holdInterestJoinContact,
	requestInterestFacts,
} from '@/lib/cta/interest-facts.server'
import { createShortlinkAttribution } from '@/lib/shortlinks-query'
import { recordSignupAttribution } from '@/lib/signup-attribution'
import { guardSubscribe } from '@/lib/subscribe-bot-defense.server'
import {
	pendingSubscribeResponse,
} from '@/lib/pending-subscribe-response'
import {
	reconcileAiHeroEmailOptInWithKit,
	routeReturningUnsubscriberWithKit,
} from '@/lib/subscriber-marketing/ai-hero-email-opt-in.server'
import {
	AIH_COURSE_ENTRY_EVIDENCE_FIELD,
	deadlineTimeZoneEvidenceFromHeader,
	deadlineTimeZoneCaptureEnabled,
	serializeDeadlineTimeZoneEvidenceForKit,
} from '@/lib/subscriber-marketing/course-sequence-exhaustion'
import {
	DOI_DROVR_FORM_IDS,
	doiAppliesTo,
	drovrSignupKitFormId,
	parseDrovrDoiConfig,
	parseDrovrSignupDeliveryConfig,
} from '@/lib/subscriber-marketing/drovr-doi-signup'
import { requestDrovrDoiSignup } from '@/lib/subscriber-marketing/drovr-doi-signup.server'
import { parseOptInAttributionCookie } from '@/lib/subscriber-marketing/opt-in-attribution'
import {
	AIH_OPTIN_ATTRIBUTION_FIELD,
	serializeOptInAttributionForKit,
} from '@/lib/subscriber-marketing/opt-in-attribution-stash'
import { kitMirrorWritesEnabled } from '@/lib/kit-mirror-writes'
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
	const rejection = await guardSubscribe(body, req.headers)
	if (rejection) return rejection
	if (waitlistOffKitEnabled()) return await offKitSignup(req, body)

	// A waitlist or interest join is recorded before any Kit or drovr signup
	// call, so it survives either being down. Recording it subscribes no one:
	// the signup below still decides consent, double opt-in included.
	if (typeof email === 'string') {
		const { queued } = await requestInterestFacts({
			email,
			fields: body.fields,
			via: 'form',
		})
		// The cut: with the facts queued, Kit no longer gets the join fields.
		if (
			(queued > 0 || !kitMirrorWritesEnabled()) &&
			!interestKitWritesEnabled()
		) {
			for (const key of interestFieldKeysOf(body.fields)) {
				delete body.fields[key]
			}
		}
	}

	// drovr-owned double opt-in, when DROVR_DOI_FORMS turns it on for this
	// form (and address, during the canary). Off, this is a no-op and the
	// signup takes Kit's path below exactly as before. A post without a
	// listId is for Kit's default form.
	const kitFormId = drovrSignupKitFormId(body, env.CONVERTKIT_SIGNUP_FORM)
	if (
		typeof email === 'string' &&
		kitFormId !== undefined &&
		doiAppliesTo(parseDrovrDoiConfig(env), kitFormId, email)
	) {
		return await doiSignup(req, body, email.trim(), kitFormId)
	}

	let mayRemoveUnsubscribeTag = true
	// A returning unsubscriber re-signs up only through a fresh drovr double
	// opt-in: no Kit subscribe, no untag. Everyone else falls through.
	if (typeof email === 'string' && kitFormId !== undefined) {
		const returning = await returningUnsubscriberSignup(
			req,
			body,
			email.trim(),
			kitFormId,
		)
		if (returning.response) return returning.response
		mayRemoveUnsubscribeTag = !returning.lookupFailed
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
				const deadlineTimeZoneResult = deadlineTimeZoneEvidenceFromHeader({
					headerValue: req.headers.get('x-vercel-ip-timezone'),
					capturedAt: subscribedAt,
				})
				const deadlineTimeZone =
					deadlineTimeZoneCaptureEnabled(process.env) &&
					deadlineTimeZoneResult.ok
						? deadlineTimeZoneResult.value
						: undefined
				const optIn = await reconcileAiHeroEmailOptInWithKit({
					email: subscriberEmail,
					subscriberState: subscriber.state,
					mayRemoveUnsubscribeTag,
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
					const stashFields = async (fields: Record<string, string>) => {
						const { setKitSubscriberFields } =
							await import('@/coursebuilder/email-list-provider')
						await setKitSubscriberFields({
							subscriber: { id: subscriber.id, fields: subscriber.fields },
							fields,
							convertkitApiSecret: env.CONVERTKIT_API_SECRET,
							convertkitApiKey: env.CONVERTKIT_API_KEY,
						})
					}
					if (serialized) {
						try {
							await stashFields({ [AIH_OPTIN_ATTRIBUTION_FIELD]: serialized })
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
					// Its own Kit call: a refused evidence field must never take
					// the attribution stash down with it.
					if (serializedCourseEntryEvidence) {
						try {
							await stashFields({
								[AIH_COURSE_ENTRY_EVIDENCE_FIELD]:
									serializedCourseEntryEvidence,
							})
						} catch (stashError) {
							await log.error('skills.course-entry-evidence.stash.failed', {
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
 * Answers a sign-up from a contact Kit shows as an earlier unsubscribe with
 * a `response`; otherwise the Kit path runs, with `lookupFailed` when Kit
 * could not be read (so the tag must not be removed).
 */
async function returningUnsubscriberSignup(
	req: NextRequest,
	body: { name?: unknown; fields?: unknown },
	email: string,
	kitFormId: number,
) {
	const name =
		typeof body.name === 'string' && body.name.trim()
			? body.name.trim()
			: undefined
	try {
		const cookieStore = await cookies()
		const result = await routeReturningUnsubscriberWithKit({
			email,
			name,
			kitFormId,
			page: req.headers.get('referer') ?? 'https://www.aihero.dev/',
			optInAttribution: parseOptInAttributionCookie(
				cookieStore.get('ft_attr')?.value,
			),
			entry: 'form',
		})
		if (result.status === 'not-unsubscribed') return {}
		// Consent lookup unreadable: carry on with the sign-up, but never untag.
		if (result.status === 'lookup-failed') return { lookupFailed: true }
		if (result.status === 'doi-requested') {
			return { response: pendingSubscribeResponse({ email, name }) }
		}
		if (result.status === 'blocked') {
			return {
				response: Response.json(
					{ error: 'Subscription could not be confirmed' },
					{ status: 409 },
				),
			}
		}
	} catch (error) {
		await log.error('skills.newsletter.doi.failed', {
			formId: kitFormId,
			error: error instanceof Error ? error.name : 'unknown',
		})
	}
	return {
		response: Response.json(
			{ error: 'Subscription could not be confirmed' },
			{ status: 502 },
		),
	}
}

/**
 * The posted form with `AIH_WAITLIST_OFF_KIT_ENABLED` on: no Kit subscribe,
 * no Kit field write, and no Kit fallback on any failure.
 *
 * - A waitlist or interest post is its fact only, never a list subscribe.
 *   An address the site has never seen gets an owned contact to hold it.
 * - A plain newsletter ask to a drovr form takes drovr's double opt-in,
 *   whatever `DROVR_DOI_FORMS` says.
 * - Anything else is refused as rejected, as an unmapped form is today.
 */
async function offKitSignup(
	req: NextRequest,
	body: { email?: unknown; name?: unknown; fields?: unknown; listId?: unknown },
) {
	const email = typeof body.email === 'string' ? body.email.trim() : ''
	const rejected = () =>
		Response.json({ error: 'Subscription was rejected' }, { status: 400 })
	const unconfirmed = () =>
		Response.json(
			{ error: 'Subscription could not be confirmed' },
			{ status: 502 },
		)
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return rejected()

	const fieldKeys = interestFieldKeysOf(body.fields)
	if (fieldKeys.length > 0) {
		const name =
			typeof body.name === 'string' && body.name.trim()
				? body.name.trim()
				: undefined
		const { queued } = await requestInterestFacts({
			email,
			fields: body.fields,
			via: 'form',
		})
		if (queued === 0) return unconfirmed()
		// After the queue, so a join that never queued mints nobody. A run that
		// looks before the contact lands finds it on its next look.
		await holdInterestJoinContact({ email, name, fieldKeys })
		const fields = body.fields as Record<string, string>
		return Response.json({
			email_address: email,
			first_name: name ?? null,
			state: 'joined',
			fields: Object.fromEntries(fieldKeys.map((key) => [key, fields[key]])),
		})
	}

	const kitFormId = drovrSignupKitFormId(body, env.CONVERTKIT_SIGNUP_FORM)
	if (kitFormId === undefined) return rejected()
	if (!parseDrovrSignupDeliveryConfig(env)) {
		await log.error('skills.newsletter.doi.failed', {
			formId: kitFormId,
			error: 'not-configured',
		})
		return unconfirmed()
	}
	return await doiSignup(req, body, email, kitFormId)
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
		return Response.json(
			{ error: 'Subscription was rejected' },
			{ status: 400 },
		)
	}
	const name =
		typeof body.name === 'string' && body.name.trim()
			? body.name.trim()
			: undefined
	try {
		const cookieStore = await cookies()
		await requestDrovrDoiSignup({
			email,
			name,
			kitFormId,
			page: req.headers.get('referer') ?? 'https://www.aihero.dev/',
			optInAttribution: parseOptInAttributionCookie(
				cookieStore.get('ft_attr')?.value,
			),
			entry: 'form',
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
	return pendingSubscribeResponse({ email, name })
}

export const POST = withSkill(subscribeWithAttribution)
