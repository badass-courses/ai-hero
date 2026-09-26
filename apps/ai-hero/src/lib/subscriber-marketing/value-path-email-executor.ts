import type { EmailListConfig } from '@coursebuilder/core/providers'

import { dispatchDrovrShadowFactSafely } from './drovr-shadow-dispatch'
import {
	resolveValuePathLinkAnchor,
	valuePathLinkFingerprint,
	type ValuePathLinkAnchorStore,
} from './value-path-link-anchor'
import { restoreDeadlineTimeZoneEvidence } from './course-sequence-exhaustion'
import { evaluateEmail7LaunchGate } from './email-7-launch-gate'
import {
	isContentCompleteSkillsWorkflowEmailResourceId,
	isTerminalSkillsWorkflowEmailResourceId,
} from './skills-workflow-path'
import type { ContactRecord, ContactState, SideEffectIntent } from './types'
import { isValuePathIntentCompleted } from './value-path-completion'
import { buildValuePathAnswerLinks } from './value-path-answer-links'
import type { ValuePathAnswerPageResource } from './value-path-answer-page'
import { buildSkillsWorkflowValuePathCertificateUrl } from './value-path-certificates'
import { AIH_COURSE_COMPLETED_AT_FIELD } from './value-path-finisher-capture'
import {
	DEFAULT_GATE_D_RETRY_POLICY,
	gateDActionReviewReasons,
	type GateDAllowedAction,
	type GateDRetryPolicy,
} from './value-path-gate-d-allowlist'
import {
	applyAcceptedValuePathSendGateReviewReasons,
	evaluateValuePathEmailSendGate,
	shouldBlockValuePathForContactState,
	type ValuePathSendGateMode,
} from './value-path-send-gate'

export type ValuePathEmailExecutorRepository = {
	findPendingValuePathEmailSideEffectIntents(args: {
		limit: number
		intentIds?: string[]
	}): Promise<SideEffectIntent[]> | SideEffectIntent[]
	findContactById(
		id: string,
	): Promise<ContactRecord | undefined> | ContactRecord | undefined
	findCurrentContactState(
		contactId: string,
	): Promise<ContactState | undefined> | ContactState | undefined
	updateSideEffectIntent(
		id: string,
		patch: Pick<
			SideEffectIntent,
			'status' | 'gates' | 'reviewReasons' | 'metadata'
		> &
			Pick<SideEffectIntent, 'completedAt'>,
	): Promise<SideEffectIntent> | SideEffectIntent
}

export type ValuePathEmailListProvider = Pick<
	EmailListConfig,
	'subscribeToList'
>

export type ValuePathEmailExecutorConfig = {
	mode?: ValuePathSendGateMode
	limit?: number
	allowWrite?: boolean
	baseUrl?: string
	pathTokenSecret?: string
	answerPages?: ValuePathAnswerPageResource[]
	allowlistedContactIds?: string[]
	allowlistedKitSubscriberIds?: string[]
	allowlistedEmails?: string[]
	enabledValuePathSlugs?: string[]
	verifiedEmailResourceIds?: string[]
	verifiedKitSequenceIds?: string[]
	acceptedReviewReasons?: string[]
	allowedActions?: readonly string[]
	retryPolicy?: Partial<GateDRetryPolicy>
	providerPacingMs?: number
	email7LiveEnabled?: boolean
	intentIds?: string[]
}

export type ValuePathEmailExecutionResult =
	| {
			status: 'completed' | 'planned'
			intentId: string
			kitSequenceId: string
			email: string
	  }
	| {
			status: 'blocked' | 'failed' | 'retryable-failed' | 'skipped'
			intentId: string
			reviewReasons: string[]
	  }

const DEFAULT_MAX_RETRY_ATTEMPTS = 5

/** Kit enrolled the contact but the completed-row write threw. */
export const KIT_ACCEPTED_COMPLETION_WRITE_FAILED =
	'kit-accepted-completion-write-failed'

export type ValuePathEmailShadowObserver = (observation: {
	courseEntryEventId: string
	legacyIntentId: string
	emailResourceId: string
	completedAt: string
}) => Promise<unknown>

/**
 * A sender that has held a row this long without finishing has crashed.
 * Longer than any sender can live (the cron runs under /api/inngest's
 * 800 s maxDuration; drovr's POST and its after() under 60 s), so a live
 * send is never reclaimed underneath itself.
 */
export const VALUE_PATH_SEND_CLAIM_STALE_MS = 15 * 60_000

/** The cron found the row but another sender (a drovr POST, another run) holds it. */
export const INTENT_CLAIMED_BY_ANOTHER_SENDER =
	'intent-claimed-by-another-sender'

/** The run's claim was taken over before it could record its outcome; it wrote nothing. */
export const SEND_CLAIM_LOST = 'send-claim-lost'

type SideEffectIntentPatch = Pick<
	SideEffectIntent,
	'status' | 'gates' | 'reviewReasons' | 'metadata' | 'completedAt'
>

export type ValuePathEmailSendClaim = {
	/**
	 * Atomically take a row for one send: pending or failed becomes sending;
	 * a sending row older than staleAfterMs can be taken again. False means
	 * another sender holds it.
	 */
	claimSideEffectIntentForSend(
		id: string,
		args: { now: string; staleAfterMs: number },
	): Promise<boolean> | boolean
	/** Write only while this claim still owns the row; undefined when it does not. */
	finishClaimedSideEffectIntent(
		id: string,
		claimedAt: string,
		patch: SideEffectIntentPatch,
	): Promise<SideEffectIntent | undefined> | SideEffectIntent | undefined
}

export async function executePendingValuePathEmailIntents(args: {
	repository: ValuePathEmailExecutorRepository & ValuePathEmailSendClaim
	emailListProvider: ValuePathEmailListProvider
	config?: ValuePathEmailExecutorConfig
	now?: string
	shadowObserver?: ValuePathEmailShadowObserver
	linkAnchors?: ValuePathLinkAnchorStore
}): Promise<ValuePathEmailExecutionResult[]> {
	const intents =
		await args.repository.findPendingValuePathEmailSideEffectIntents({
			limit: args.config?.limit ?? 25,
			intentIds: args.config?.intentIds,
		})
	const configBlockers = valuePathEmailExecutorConfigBlockers({
		intents,
		config: args.config,
	})
	if (configBlockers.length > 0) {
		return [
			{
				status: 'blocked',
				intentId: 'executor-preflight',
				reviewReasons: configBlockers,
			},
		]
	}

	const providerPacingMs = normalizeProviderPacingMs(
		args.config?.providerPacingMs,
	)
	const results: ValuePathEmailExecutionResult[] = []
	for (const [index, intent] of intents.entries()) {
		if (index > 0 && providerPacingMs > 0) {
			await sleep(providerPacingMs)
		}
		results.push(await executeClaimedValuePathEmailIntent({ ...args, intent }))
	}
	return results
}

/**
 * The cron's send takes the row's claim first, as drovr's POST does, so a
 * POST or another run sending the same row makes it step back instead of
 * calling Kit twice. A no-write run touches nothing and takes no claim.
 */
async function executeClaimedValuePathEmailIntent(
	args: Parameters<typeof executeValuePathEmailIntent>[0] & {
		repository: ValuePathEmailExecutorRepository & ValuePathEmailSendClaim
	},
): Promise<ValuePathEmailExecutionResult> {
	if (args.config?.allowWrite === false) {
		return await executeValuePathEmailIntent(args)
	}
	const claimedAt = args.now ?? new Date().toISOString()
	const claimed = await args.repository.claimSideEffectIntentForSend(
		args.intent.id,
		{ now: claimedAt, staleAfterMs: VALUE_PATH_SEND_CLAIM_STALE_MS },
	)
	if (!claimed) {
		return {
			status: 'skipped',
			intentId: args.intent.id,
			reviewReasons: [INTENT_CLAIMED_BY_ANOTHER_SENDER],
		}
	}
	// Every write to this row goes through the claim, so a run whose claim
	// went stale and was taken over cannot overwrite the newer sender.
	let claimLost = false
	const finish = async (patch: SideEffectIntentPatch) => {
		const finished = await args.repository.finishClaimedSideEffectIntent(
			args.intent.id,
			claimedAt,
			patch,
		)
		if (!finished) claimLost = true
		return finished
	}
	const repository: ValuePathEmailExecutorRepository = {
		findPendingValuePathEmailSideEffectIntents: (scope) =>
			args.repository.findPendingValuePathEmailSideEffectIntents(scope),
		findContactById: (id) => args.repository.findContactById(id),
		findCurrentContactState: (contactId) =>
			args.repository.findCurrentContactState(contactId),
		updateSideEffectIntent: async (id, patch) => {
			if (id !== args.intent.id) {
				return await args.repository.updateSideEffectIntent(id, patch)
			}
			const finished = await finish(patch)
			if (!finished) throw new Error(SEND_CLAIM_LOST)
			return finished
		},
	}
	const lost = (): ValuePathEmailExecutionResult => ({
		status: 'skipped',
		intentId: args.intent.id,
		reviewReasons: [SEND_CLAIM_LOST],
	})
	let outcome: ValuePathEmailExecutionResult
	try {
		// The executor sees the row as this run read it (pending or a due
		// failed row); every outcome that writes overwrites the claim.
		outcome = await executeValuePathEmailIntent({ ...args, repository })
	} catch (cause) {
		if (claimLost) return lost()
		await releaseValuePathSendClaim(finish, args.intent)
		throw cause
	}
	if (claimLost) return lost()
	if (outcomeLeavesClaim(outcome)) {
		await releaseValuePathSendClaim(finish, args.intent)
	}
	return outcome
}

/** Outcomes that wrote nothing to the row, so it is still claimed. */
function outcomeLeavesClaim(outcome: ValuePathEmailExecutionResult): boolean {
	if (outcome.status === 'skipped' || outcome.status === 'planned') return true
	return (
		outcome.status === 'retryable-failed' &&
		outcome.reviewReasons.includes(KIT_ACCEPTED_COMPLETION_WRITE_FAILED)
	)
}

/**
 * Put a claimed row back as the run read it, so the next run or a drovr
 * re-ask can take it. Only while the claim is still this run's; best
 * effort: a failed release leaves the row sending until its claim goes
 * stale and a re-ask takes it again.
 */
async function releaseValuePathSendClaim(
	finish: (patch: SideEffectIntentPatch) => Promise<unknown>,
	row: SideEffectIntent,
): Promise<void> {
	try {
		await finish({
			status: row.status,
			gates: row.gates,
			reviewReasons: row.reviewReasons,
			metadata: row.metadata,
			completedAt: row.completedAt,
		})
	} catch {
		// Stays sending; VALUE_PATH_SEND_CLAIM_STALE_MS bounds how long.
	}
}

export async function executeValuePathEmailIntent(args: {
	repository: ValuePathEmailExecutorRepository
	emailListProvider: ValuePathEmailListProvider
	intent: SideEffectIntent
	config?: ValuePathEmailExecutorConfig
	now?: string
	shadowObserver?: ValuePathEmailShadowObserver
	/** Anchors answer links at their first issue; absent keeps now + 30 days. */
	linkAnchors?: ValuePathLinkAnchorStore
}): Promise<ValuePathEmailExecutionResult> {
	const intent = args.intent
	if (intent.provider !== 'kit' || intent.type !== 'send-value-path-email') {
		return {
			status: 'skipped',
			intentId: intent.id,
			reviewReasons: ['intent-not-value-path-kit-send'],
		}
	}
	if (isValuePathIntentCompleted(intent)) {
		return {
			status: 'skipped',
			intentId: intent.id,
			reviewReasons: ['intent-already-completed'],
		}
	}
	if (!isExecutableValuePathEmailIntent(intent, args.now)) {
		return {
			status: 'skipped',
			intentId: intent.id,
			reviewReasons: [`intent-status-${intent.status}`],
		}
	}

	const metadata = parseValuePathEmailIntentMetadata(intent.metadata)
	const contact = await args.repository.findContactById(intent.contactId)
	const state = contact
		? await args.repository.findCurrentContactState(contact.id)
		: undefined
	const email = contact?.email?.trim().toLowerCase()
	const mode = args.config?.mode ?? metadata.mode

	const preflightReasons = [
		...(contact ? [] : ['contact-missing']),
		...(state ? [] : ['contact-state-missing']),
		...(email ? [] : ['contact-email-missing']),
		...(metadata.kitSequenceId ? [] : ['kit-sequence-missing']),
		...(metadata.emailResourceId ? [] : ['email-resource-missing']),
		...(metadata.valuePathSlug ? [] : ['value-path-missing']),
	]

	const email7LaunchGate = evaluateEmail7LaunchGate({
		emailResourceId: metadata.emailResourceId,
		email,
		liveEnabled: args.config?.email7LiveEnabled,
	})
	const decision = applyAcceptedValuePathSendGateReviewReasons(
		evaluateValuePathEmailSendGate({
			mode,
			contactId: intent.contactId,
			kitSubscriberId: metadata.kitSubscriberId,
			email,
			valuePathSlug: metadata.valuePathSlug ?? 'unknown-value-path',
			emailResourceId: metadata.emailResourceId ?? 'unknown-email-resource',
			kitSequenceId: metadata.kitSequenceId,
			humanReview: shouldBlockValuePathForContactState(state),
			lifecycle: state?.lifecycle,
			reviewSignals: state?.reviewSignals,
			allowlistedContactIds: args.config?.allowlistedContactIds,
			allowlistedKitSubscriberIds: args.config?.allowlistedKitSubscriberIds,
			allowlistedEmails: args.config?.allowlistedEmails,
			enabledValuePathSlugs: args.config?.enabledValuePathSlugs,
			verifiedEmailResourceIds: args.config?.verifiedEmailResourceIds,
			verifiedKitSequenceIds: args.config?.verifiedKitSequenceIds,
		}),
		args.config?.acceptedReviewReasons ?? [],
	)

	const reviewReasons = unique([
		...preflightReasons,
		...gateDActionReviewReasons({
			allowedActions: args.config?.allowedActions,
			requiredActions: requiredExecutorActions(intent, args.now),
		}),
		...email7LaunchGate.reviewReasons,
		...decision.reviewReasons,
	])
	const gates = [
		{
			slug: email7LaunchGate.slug,
			passed: email7LaunchGate.passed,
			reason: email7LaunchGate.reason,
		},
		...decision.gates,
	]
	if (reviewReasons.length > 0 || !decision.passed) {
		if (args.config?.allowWrite !== false) {
			await args.repository.updateSideEffectIntent(intent.id, {
				status: 'blocked',
				gates,
				reviewReasons,
				metadata: {
					...intent.metadata,
					providerResult: null,
					blockedAt: args.now ?? new Date().toISOString(),
				},
			})
		}
		return { status: 'blocked', intentId: intent.id, reviewReasons }
	}

	// Once Kit has enrolled the contact, nothing after it is a Kit failure.
	let kitAccepted = false
	try {
		// A no-write run plans and must not record a first issue.
		const linkExpiresAt =
			args.config?.allowWrite === false
				? undefined
				: await anchoredValuePathLinkExpiry({
						linkAnchors: args.linkAnchors,
						contactId: intent.contactId,
						kitSubscriberId: metadata.kitSubscriberId,
						valuePathSlug: metadata.valuePathSlug,
						emailResourceId: metadata.emailResourceId,
						answerPages: args.config?.answerPages ?? [],
						baseUrl: args.config?.baseUrl,
						pathTokenSecret: args.config?.pathTokenSecret,
						now: args.now ?? new Date().toISOString(),
					})
		const personalization = buildValuePathEmailPersonalization({
			contactId: intent.contactId,
			kitSubscriberId: metadata.kitSubscriberId,
			valuePathSlug: metadata.valuePathSlug,
			emailResourceId: metadata.emailResourceId,
			answerPages: args.config?.answerPages ?? [],
			baseUrl: args.config?.baseUrl,
			pathTokenSecret: args.config?.pathTokenSecret,
			now: args.now,
			linkExpiresAt,
		})
		if (!personalization.passed) {
			if (args.config?.allowWrite !== false) {
				await args.repository.updateSideEffectIntent(intent.id, {
					status: 'blocked',
					gates,
					reviewReasons: personalization.reviewReasons,
					metadata: {
						...intent.metadata,
						providerResult: null,
						blockedAt: args.now ?? new Date().toISOString(),
					},
				})
			}
			return {
				status: 'blocked',
				intentId: intent.id,
				reviewReasons: personalization.reviewReasons,
			}
		}

		if (args.config?.allowWrite === false) {
			return {
				status: 'planned',
				intentId: intent.id,
				kitSequenceId: metadata.kitSequenceId!,
				email: email!,
			}
		}

		const providerResult = await args.emailListProvider.subscribeToList({
			listId: metadata.kitSequenceId!,
			listType: 'sequence',
			user: {
				email: email!,
				name: contact?.name,
			} as Parameters<EmailListConfig['subscribeToList']>[0]['user'],
			fields: personalization.fields,
		})
		kitAccepted = true
		const completedAt = args.now ?? new Date().toISOString()
		const completedMetadata = {
			...intent.metadata,
			providerResult: summarizeProviderResult(providerResult),
			completedAt,
		}
		await args.repository.updateSideEffectIntent(intent.id, {
			status: 'completed',
			completedAt,
			gates,
			reviewReasons: [],
			metadata: completedMetadata,
		})
		if (
			args.shadowObserver &&
			metadata.courseEntryEventId &&
			metadata.emailResourceId
		) {
			await observeShadowWithoutThrow(args.shadowObserver, {
				courseEntryEventId: metadata.courseEntryEventId,
				legacyIntentId: intent.id,
				emailResourceId: metadata.emailResourceId,
				completedAt,
			})
		}
		dispatchDrovrShadowFactSafely({
			kind: 'side-effect-intent-completed',
			intent: {
				...intent,
				status: 'completed',
				completedAt,
				gates,
				reviewReasons: [],
				metadata: completedMetadata,
			},
		})
		if (
			metadata.valuePathSlug &&
			isTerminalSkillsWorkflowEmailResourceId(metadata.emailResourceId)
		) {
			dispatchDrovrShadowFactSafely({
				kind: 'course-completed',
				contactId: intent.contactId,
				valuePathSlug: metadata.valuePathSlug,
				completedAt,
				...(metadata.courseDeadlineTimeZone
					? {
							timezone: {
								timezone: metadata.courseDeadlineTimeZone.timeZone,
								timezoneSource:
									metadata.courseDeadlineTimeZone.type === 'BrowserEntryHeader'
										? 'vercel-header'
										: 'fallback',
							},
						}
					: {}),
			})
		}
		return {
			status: 'completed',
			intentId: intent.id,
			kitSequenceId: metadata.kitSequenceId!,
			email: email!,
		}
	} catch (error) {
		if (kitAccepted) {
			// The email is going out; only recording it failed. Leave the row
			// executable: the next run re-adds (a no-op for a sequence) and
			// records completion. A terminal failure here would close drovr's
			// intent with no transition while the contact got the email.
			return {
				status: 'retryable-failed',
				intentId: intent.id,
				reviewReasons: [KIT_ACCEPTED_COMPLETION_WRITE_FAILED],
			}
		}
		const message = error instanceof Error ? error.message : String(error)
		const retry = classifyKitEnrollmentError(error)
		const previousAttempts = numberField(intent.metadata.retryAttemptCount) ?? 0
		const nextAttemptCount = previousAttempts + 1
		const maxAttempts =
			numberField(intent.metadata.maxRetryAttempts) ??
			args.config?.retryPolicy?.maxProviderRetryAttempts ??
			DEFAULT_MAX_RETRY_ATTEMPTS
		const now = args.now ?? new Date().toISOString()
		const canRetry = retry.retryable && nextAttemptCount < maxAttempts
		const retryDelayMs =
			(args.config?.retryPolicy?.providerRetryDelayMinutes ??
				DEFAULT_GATE_D_RETRY_POLICY.providerRetryDelayMinutes) *
			60 *
			1000
		const nextRetryAt = canRetry
			? new Date(Date.parse(now) + retryDelayMs).toISOString()
			: undefined
		const failed = await args.repository.updateSideEffectIntent(intent.id, {
			status: 'failed',
			gates,
			reviewReasons: [
				canRetry
					? 'kit-sequence-enrollment-retryable'
					: 'kit-sequence-enrollment-failed',
			],
			metadata: {
				...intent.metadata,
				providerResult: summarizeKitEnrollmentError(error, message),
				failedAt: now,
				retryable: canRetry,
				retryReason: retry.reason,
				retryAttemptCount: nextAttemptCount,
				maxRetryAttempts: maxAttempts,
				...(nextRetryAt ? { nextRetryAt } : {}),
			},
		})
		if (!canRetry) {
			dispatchDrovrShadowFactSafely({
				kind: 'side-effect-intent-failed',
				intent: failed,
			})
		}
		return {
			status: canRetry ? 'retryable-failed' : 'failed',
			intentId: intent.id,
			reviewReasons: [
				canRetry
					? 'kit-sequence-enrollment-retryable'
					: 'kit-sequence-enrollment-failed',
			],
		}
	}
}

/** The answer pages one email of a value path links to. */
export function valuePathAnswerPagesForEmail(args: {
	valuePathSlug?: string
	emailResourceId?: string
	answerPages: readonly ValuePathAnswerPageResource[]
}): ValuePathAnswerPageResource[] {
	const emailId = emailIdFromResourceId(args.emailResourceId)
	return args.answerPages.filter(
		(page) =>
			page.fields.sequenceId === args.valuePathSlug &&
			page.fields.emailId === emailId,
	)
}

/**
 * The anchored expiry for this email's answer-URL token, or undefined to
 * keep the send-time expiry: no store, no answer pages to link, or a store
 * that is unavailable.
 */
export async function anchoredValuePathLinkExpiry(args: {
	linkAnchors?: ValuePathLinkAnchorStore
	contactId: string
	kitSubscriberId?: string
	valuePathSlug?: string
	emailResourceId?: string
	answerPages: readonly ValuePathAnswerPageResource[]
	baseUrl?: string
	pathTokenSecret?: string
	now: string
	warn?: (event: string, fields: Record<string, unknown>) => unknown
}): Promise<string | undefined> {
	if (!args.linkAnchors || !args.valuePathSlug || !args.emailResourceId) {
		return undefined
	}
	const pages = valuePathAnswerPagesForEmail(args)
	if (pages.length === 0 || !args.pathTokenSecret) return undefined
	const anchor = await resolveValuePathLinkAnchor({
		store: args.linkAnchors,
		key: {
			contactId: args.contactId,
			valuePathSlug: args.valuePathSlug,
			emailResourceId: args.emailResourceId,
			fingerprint: valuePathLinkFingerprint({
				kitSubscriberId: args.kitSubscriberId,
				baseUrl: args.baseUrl,
				secret: args.pathTokenSecret,
				answerPages: pages,
			}),
		},
		now: args.now,
		warn: args.warn,
	})
	return anchor?.expiresAt
}

export function buildValuePathEmailPersonalization(args: {
	contactId: string
	kitSubscriberId?: string
	valuePathSlug?: string
	emailResourceId?: string
	answerPages: ValuePathAnswerPageResource[]
	baseUrl?: string
	pathTokenSecret?: string
	now?: string
	/** The anchored token expiry (anchoredValuePathLinkExpiry); else now + 30 days. */
	linkExpiresAt?: string
}) {
	const reviewReasons: string[] = []
	if (!args.valuePathSlug) reviewReasons.push('value-path-slug-missing')
	if (!args.emailResourceId) reviewReasons.push('email-resource-missing')

	const emailId = emailIdFromResourceId(args.emailResourceId)
	const answerPages = valuePathAnswerPagesForEmail(args)
	if (
		answerPages.length === 0 &&
		!isContentCompleteSkillsWorkflowEmailResourceId(args.emailResourceId)
	) {
		reviewReasons.push('answer-pages-missing')
	}
	if (answerPages.length > 1) {
		// Without explicit positions the link builder falls back to id order,
		// which silently mismatches the template's fixed button order.
		const positions = answerPages.map((page) => page.fields.position)
		if (positions.some((position) => position === undefined)) {
			reviewReasons.push('answer-page-position-missing')
		} else if (new Set(positions).size !== positions.length) {
			reviewReasons.push('answer-page-position-duplicate')
		}
	}
	if (
		(answerPages.length > 0 ||
			isTerminalSkillsWorkflowEmailResourceId(args.emailResourceId)) &&
		!args.baseUrl
	) {
		reviewReasons.push('value-path-base-url-missing')
	}
	if (answerPages.length > 0 && !args.pathTokenSecret) {
		reviewReasons.push('path-token-secret-missing')
	}

	if (reviewReasons.length > 0) {
		return { passed: false, reviewReasons, fields: {} }
	}
	const now = args.now ?? new Date().toISOString()
	const lifecycleFields: Record<string, string> = {}
	if (emailId === 'email-0' || emailId === 'team-email-0') {
		lifecycleFields.aih_course_started_at = now
	}
	if (isTerminalSkillsWorkflowEmailResourceId(args.emailResourceId)) {
		lifecycleFields[AIH_COURSE_COMPLETED_AT_FIELD] = now
		lifecycleFields.aih_value_path_certificate_url =
			buildSkillsWorkflowValuePathCertificateUrl({
				baseUrl: args.baseUrl!,
				contactId: args.contactId,
			})
	}
	if (answerPages.length === 0) {
		return { passed: true, reviewReasons: [], fields: lifecycleFields }
	}

	const answerLinks = buildValuePathAnswerLinks({
		baseUrl: args.baseUrl!,
		secret: args.pathTokenSecret!,
		tokenPayload: {
			contactId: args.contactId,
			kitSubscriberId: args.kitSubscriberId,
			valuePathResourceId: args.valuePathSlug!,
			emailResourceId: args.emailResourceId!,
			sequenceId: args.valuePathSlug!,
			expiresAt: args.linkExpiresAt ?? expirationDateIso(now),
		},
		answerPages,
	})
	const fields: Record<string, string> = {
		...lifecycleFields,
		aih_value_path_email_resource_id: args.emailResourceId!,
		aih_value_path_slug: args.valuePathSlug!,
		aih_value_path_answer_links_json: JSON.stringify(answerLinks),
	}
	for (const [index, link] of answerLinks.entries()) {
		const ordinal = String(index + 1)
		fields[`aih_value_path_answer_${ordinal}_url`] = link.href
		if (link.optionValue) {
			fields[`aih_value_path_answer_${safeFieldKey(link.optionValue)}_url`] =
				link.href
		}
	}
	return { passed: true, reviewReasons: [], fields }
}

export function parseExecutorList(value?: string) {
	return (value ?? '')
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean)
}

export function parseExecutorMode(value?: string): ValuePathSendGateMode {
	if (
		value === 'allowlisted-test' ||
		value === 'scoped-live' ||
		value === 'dry-run'
	) {
		return value
	}
	return 'dry-run'
}

function requiredExecutorActions(
	intent: SideEffectIntent,
	now?: string,
): GateDAllowedAction[] {
	return isDueRetryableValuePathEmailIntent(intent, now)
		? ['retry-transient-provider-failures', 'send-path-emails']
		: ['send-path-emails']
}

function valuePathEmailExecutorConfigBlockers(args: {
	intents: SideEffectIntent[]
	config?: ValuePathEmailExecutorConfig
}) {
	const requiresAnswerLinks = args.intents.some((intent) => {
		const metadata = parseValuePathEmailIntentMetadata(intent.metadata)
		return !isContentCompleteSkillsWorkflowEmailResourceId(
			metadata.emailResourceId,
		)
	})
	if (!requiresAnswerLinks) return []
	return [
		...(args.config?.baseUrl ? [] : ['value-path-base-url-missing']),
		...(args.config?.pathTokenSecret ? [] : ['path-token-secret-missing']),
	]
}

function emailIdFromResourceId(resourceId?: string) {
	if (!resourceId) return undefined
	const [, emailId] = resourceId.split(/\.(.+)/)
	return emailId
}

function expirationDateIso(now: string) {
	const expiresAt = new Date(now)
	expiresAt.setDate(expiresAt.getDate() + 30)
	return expiresAt.toISOString()
}

function safeFieldKey(value: string) {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
}

export function isDueRetryableValuePathEmailIntent(
	intent: SideEffectIntent,
	now?: string,
) {
	if (intent.status !== 'failed') return false
	if (intent.provider !== 'kit' || intent.type !== 'send-value-path-email') {
		return false
	}
	if (intent.metadata.retryable !== true) return false
	const nextRetryAt = stringField(intent.metadata.nextRetryAt)
	return !nextRetryAt || nextRetryAt <= (now ?? new Date().toISOString())
}

function isExecutableValuePathEmailIntent(
	intent: SideEffectIntent,
	now?: string,
) {
	return (
		intent.status === 'pending' ||
		isDueRetryableValuePathEmailIntent(intent, now)
	)
}

export function classifyKitEnrollmentError(error: unknown): {
	retryable: boolean
	reason: string
} {
	const message = error instanceof Error ? error.message : String(error)
	const normalized = message.toLowerCase()
	const bodySnippet = stringProperty(error, 'bodySnippet')?.toLowerCase()
	if (
		normalized.includes('retry later') ||
		bodySnippet?.includes('retry later')
	) {
		return { retryable: true, reason: 'kit-retry-later' }
	}
	if (normalized.includes('timeout') || normalized.includes('timed out')) {
		return { retryable: true, reason: 'kit-timeout' }
	}
	if (
		normalized.includes('unexpected token') &&
		normalized.includes('not valid json')
	) {
		return { retryable: true, reason: 'kit-invalid-json-response' }
	}
	const status = statusCodeFromError(error, message)
	if (status === 429) return { retryable: true, reason: 'kit-rate-limited' }
	if (status && status >= 500 && status <= 599) {
		return { retryable: true, reason: 'kit-5xx' }
	}
	return { retryable: false, reason: 'kit-permanent-error' }
}

function statusCodeFromError(error: unknown, message: string) {
	const record =
		error && typeof error === 'object' ? (error as Record<string, unknown>) : {}
	for (const key of ['status', 'statusCode', 'code']) {
		const value = record[key]
		if (typeof value === 'number') return value
		if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
	}
	const match = message.match(/\b(429|5\d\d)\b/)
	return match ? Number(match[1]) : undefined
}

function summarizeKitEnrollmentError(error: unknown, message: string) {
	const status = statusCodeFromError(error, message)
	return {
		ok: false,
		error: message,
		...(status ? { status } : {}),
		...(stringProperty(error, 'statusText')
			? { statusText: stringProperty(error, 'statusText') }
			: {}),
		...(stringProperty(error, 'bodySnippet')
			? { bodySnippet: stringProperty(error, 'bodySnippet') }
			: {}),
		...(recordProperty(error, 'responseHeaders')
			? { responseHeaders: recordProperty(error, 'responseHeaders') }
			: {}),
	}
}

function stringProperty(error: unknown, key: string) {
	const record =
		error && typeof error === 'object' ? (error as Record<string, unknown>) : {}
	const value = record[key]
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

function recordProperty(error: unknown, key: string) {
	const record =
		error && typeof error === 'object' ? (error as Record<string, unknown>) : {}
	const value = record[key]
	return value && typeof value === 'object'
		? (value as Record<string, unknown>)
		: undefined
}

function normalizeProviderPacingMs(value: unknown) {
	return typeof value === 'number' && Number.isFinite(value)
		? Math.max(0, Math.trunc(value))
		: 0
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseValuePathEmailIntentMetadata(metadata: Record<string, unknown>) {
	return {
		mode: parseExecutorMode(stringField(metadata.mode)),
		courseEntryEventId: stringField(metadata.courseEntryEventId),
		valuePathSlug: stringField(metadata.valuePathSlug),
		emailResourceId: stringField(metadata.emailResourceId),
		kitSequenceId: stringField(metadata.kitSequenceId),
		kitSubscriberId: stringField(metadata.kitSubscriberId),
		courseDeadlineTimeZone: restoreDeadlineTimeZoneEvidence(
			metadata.courseDeadlineTimeZone,
		),
	}
}

async function observeShadowWithoutThrow(
	observer: ValuePathEmailShadowObserver,
	observation: Parameters<ValuePathEmailShadowObserver>[0],
): Promise<void> {
	try {
		await observer(observation)
	} catch {
		// Shadow state and parity cannot alter the committed production delivery.
	}
}

function stringField(value: unknown) {
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberField(value: unknown) {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function unique(values: string[]) {
	return Array.from(new Set(values))
}

function summarizeProviderResult(value: unknown) {
	if (!value || typeof value !== 'object') return { ok: true }
	const record = value as Record<string, unknown>
	return {
		ok: true,
		id: record.id,
		email_address: record.email_address,
	}
}
