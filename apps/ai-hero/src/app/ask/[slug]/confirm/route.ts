import { NextResponse, type NextRequest } from 'next/server'

import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { db } from '@/db'
import { VALUE_PATH_ANSWER_SELECTED_EVENT } from '@/inngest/events/value-path'
import { inngest } from '@/inngest/inngest.server'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import { ensureSkillsWorkflowCertificateShare } from '@/lib/subscriber-marketing/value-path-certificate-shares'
import { checkSkillsWorkflowValuePathCertificateEligibility } from '@/lib/subscriber-marketing/value-path-certificates'
import { recordValuePathAnswerProgression } from '@/lib/subscriber-marketing/value-path-click-progression'
import { parseExecutorList } from '@/lib/subscriber-marketing/value-path-email-executor'
import {
	readActiveGateDRuntimeAllowlist,
	resolveGateDPreAuthorizedReviewReasons,
} from '@/lib/subscriber-marketing/value-path-gate-d-allowlist'
import { isSyntheticPrincipalId } from '@/lib/synthetic-principal'
import { log } from '@/server/logger'
import { redis } from '@/server/redis-client'
import { withSkill } from '@/server/with-skill'

import {
	answerLandingPath,
	errorMessage,
	isCertificateAnswer,
	resolveAnswerLanding,
} from '../answer-landing'

/**
 * POST /ask/{slug}/confirm is the only place an answer is recorded. The
 * emailed link's GET only renders a confirm button: mail gateways (Safe
 * Links, Proofpoint, Mimecast) fetch links before delivery and at click,
 * and a fetch must never pick a recipient's course path. Idempotent: a
 * repeat POST finds the recorded answer and emits nothing. Answers 303 to
 * the landing's confirmed view either way.
 */
export const POST = withSkill(
	async (
		request: NextRequest,
		context: { params: Promise<{ slug: string }> },
	) => {
		const { slug } = await context.params
		// Only our own Confirm button may record: a cross-site page or a
		// scanner posting from elsewhere is refused before anything is read.
		if (!isSameOriginPost(request)) {
			await log.warn('value-path.ask.confirm_cross_site_refused', {
				slug,
				origin: request.headers.get('origin') ?? undefined,
				secFetchSite: request.headers.get('sec-fetch-site') ?? undefined,
			})
			return new NextResponse(null, { status: 403 })
		}
		const form = await request.formData().catch(() => undefined)
		const pt = formString(form?.get('pt'))
		const answer = formString(form?.get('answer'))
		const { token, answerPage } = await resolveAnswerLanding({
			slug,
			pt,
			answer,
		})
		if (!answerPage) {
			return new NextResponse(null, { status: 404 })
		}
		if (!token.valid) {
			return seeOther(request, answerLandingPath({ slug, pt, answer }))
		}

		// A thrown read or a thrown record is a failure to retry; a blocked
		// allowlist or a skipped progression is a decision, shown as done.
		let recordingFailed = false
		const runtimeAllowlistDecision = await readActiveGateDRuntimeAllowlist({
			redis,
		}).catch(async (error) => {
			recordingFailed = true
			await log.error('value-path.ask.allowlist_read_failed', {
				slug,
				contactId: token.payload.contactId,
				error: errorMessage(error),
			})
			return undefined
		})
		const runtimeAllowlist = runtimeAllowlistDecision?.passed
			? runtimeAllowlistDecision.allowlist
			: undefined
		if (!runtimeAllowlist) {
			await log.warn('value-path.ask.authorization_blocked', {
				slug,
				contactId: token.payload.contactId,
				reviewReasons: runtimeAllowlistDecision?.reviewReasons ?? [
					'gate-d-allowlist-missing',
				],
			})
		}
		const progression = runtimeAllowlist
			? await recordValuePathAnswerProgression({
					repository: new DrizzleCaptureMarketingRepository(db),
					finisherFieldProvider: emailListProvider,
					token: token.payload,
					answerPage,
					mode: runtimeAllowlist.mode,
					sendGate: {
						allowedActions: runtimeAllowlist.allowedActions,
						allowlistedContactIds: runtimeAllowlist.contactIds,
						allowlistedKitSubscriberIds: runtimeAllowlist.kitSubscriberIds,
						allowlistedEmails: runtimeAllowlist.emails,
						enabledValuePathSlugs: runtimeAllowlist.pathSlugs,
						verifiedEmailResourceIds: runtimeAllowlist.emailResourceIds,
						verifiedKitSequenceIds: runtimeAllowlist.kitSequenceIds,
					},
					acceptedReviewReasons: resolveGateDPreAuthorizedReviewReasons({
						allowlist: runtimeAllowlist,
						legacyEnvReviewReasons: parseExecutorList(
							process.env.AIH_VALUE_PATH_ACCEPTED_REVIEW_REASONS,
						),
					}),
				}).catch(async (error) => {
					recordingFailed = true
					await log.error('value-path.ask.progression_failed', {
						slug,
						contactId: token.payload.contactId,
						error: errorMessage(error),
					})
					return undefined
				})
			: undefined

		if (runtimeAllowlist && progression?.status !== 'recorded') {
			await log.warn('value-path.ask.progression_not_recorded', {
				slug,
				contactId: token.payload.contactId,
				status: progression?.status,
				reviewReasons: progression?.reviewReasons,
			})
		}
		if (progression?.status === 'recorded') {
			await log.info('value-path.ask.answer_recorded', {
				slug,
				contactId: token.payload.contactId,
				valuePathSlug: token.payload.valuePathResourceId,
				emailResourceId: token.payload.emailResourceId,
				contactEventId: progression.contactEventId,
				finisherCapture: progression.finisherCapture,
			})
			await inngest
				.send({
					name: VALUE_PATH_ANSWER_SELECTED_EVENT,
					data: {
						contactId: token.payload.contactId,
						valuePathSlug: token.payload.valuePathResourceId,
						sentEmailResourceId: token.payload.emailResourceId,
						answerPageId: answerPage.id,
						contactEventId: progression.contactEventId,
					},
				})
				.catch(async (error) => {
					await log.error('value-path.ask.answer_event_send_failed', {
						slug,
						contactId: token.payload.contactId,
						contactEventId: progression.contactEventId,
						error: errorMessage(error),
					})
				})
		}

		// A finisher's certificate share is created here, on the confirm, never
		// by the landing GET. A synthetic principal never persists one.
		const certificateShareAvailable =
			isCertificateAnswer(answerPage) &&
			!isSyntheticPrincipalId(token.payload.contactId)
				? await ensureCertificateShare(slug, token.payload.contactId)
				: false

		// A finisher whose certificate is ready still lands on it; anyone else
		// whose answer failed to save gets the Confirm button back.
		if (recordingFailed && !certificateShareAvailable) {
			return seeOther(
				request,
				answerLandingPath({ slug, pt, answer, retry: true }),
			)
		}
		return seeOther(
			request,
			answerLandingPath({ slug, pt, answer, confirmed: true }),
		)
	},
)

/** True when the finisher's share exists after this call. */
async function ensureCertificateShare(
	slug: string,
	contactId: string,
): Promise<boolean> {
	const eligibility = await checkSkillsWorkflowValuePathCertificateEligibility({
		contactId,
	}).catch(async (error) => {
		await log.error('value-path.certificate.eligibility_failed', {
			slug,
			contactId,
			error: errorMessage(error),
		})
		return undefined
	})
	if (!eligibility?.eligible) return false
	const result = await ensureSkillsWorkflowCertificateShare({
		eligibility,
	}).catch(() => ({
		available: false as const,
		reason: 'share-persistence-failed',
	}))
	if (!result.available) {
		await log.warn('value-path.certificate.share_unavailable', {
			slug,
			contactId: eligibility.contactId,
			reason: result.reason,
		})
	}
	return result.available
}

const SITE_ORIGINS = ['https://www.aihero.dev', 'https://aihero.dev']

/**
 * Browsers send Origin on every form POST; Sec-Fetch-Site covers one that
 * withholds it. Only the site's origins (and its canonical URL) pass; an
 * opaque `Origin: null` is cross-site.
 */
function isSameOriginPost(request: NextRequest) {
	const origin = request.headers.get('origin')
	if (origin) {
		const allowed = new Set(SITE_ORIGINS)
		const canonical = process.env.NEXT_PUBLIC_URL
		if (canonical) {
			try {
				allowed.add(new URL(canonical).origin)
			} catch {
				// An unparseable canonical URL adds nothing.
			}
		}
		return allowed.has(origin)
	}
	return request.headers.get('sec-fetch-site') === 'same-origin'
}

/** 303 so the browser follows with a GET, which records nothing. */
function seeOther(request: NextRequest, path: string) {
	return NextResponse.redirect(new URL(path, request.url), 303)
}

function formString(value: FormDataEntryValue | null | undefined) {
	return typeof value === 'string' && value.length > 0 ? value : undefined
}
