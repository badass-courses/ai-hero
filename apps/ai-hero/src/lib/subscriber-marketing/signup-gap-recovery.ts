import {
	SKILLS_NEWSLETTER_SUBSCRIBED_EVENT,
	type SkillsNewsletterSubscribed,
} from '@/inngest/events/skills-newsletter'
import type { OptInAttribution } from '@/lib/subscriber-marketing/opt-in-attribution'
import { parseStashedOptInAttribution } from '@/lib/subscriber-marketing/opt-in-attribution-stash'

export type SignupGapKitSubscriberState =
	| 'active'
	| 'inactive'
	| 'cancelled'
	| 'bounced'
	| 'complained'

export type SignupGapKitSubscriber = {
	kitSubscriberId: string
	email: string
	firstName?: string
	createdAt: string
	addedAt: string
	state: SignupGapKitSubscriberState
	fields?: Record<string, unknown>
}

export type SignupGapIdentityMatches = {
	contactEmails: ReadonlySet<string>
	kitSubscriberIds: ReadonlySet<string>
	courseEntryKitSubscriberIds: ReadonlySet<string>
}

export type SignupGapPreviewCandidate = {
	kitSubscriberId: string
	email: string
	firstName?: string
	createdAt: string
	addedAt: string
	maskedEmail: string
	excludedSynthetic: boolean
	exclusionReason?: 'synthetic-address'
	optInAttribution?: OptInAttribution
}

export type SignupGapPreview = {
	mode: 'signup-gap-preview'
	generatedAt: string
	formId: number
	window: {
		from: string
		to: string
	}
	counts: {
		kitFormSubscribersFetched: number
		inWindow: number
		withExistingContact: number
		withExistingProviderIdentity: number
		withExistingIdentity: number
		withExistingCourseEntry: number
		gapCandidates: number
		excludedSynthetic: number
		unconfirmed: number
		replayable: number
		stateBreakdown: {
			active: number
			inactiveUnconfirmed: number
			cancelled: number
			bounced: number
			complained: number
		}
	}
	workSeen: number
	workDone: number
	/**
	 * Kit does not expose when a subscriber changed from inactive to active.
	 * These stay null until we have a real confirmation timestamp or durable
	 * first-seen tracking across reconciliation runs.
	 */
	oldestUnservedAgeHours: number | null
	oldestUnservedAt: string | null
	/** Subscriber creation time is source context, not gap age. */
	oldestCandidateSubscriberAgeHours: number | null
	oldestCandidateSubscriberCreatedAt: string | null
	unservedAgeBasis: 'unavailable-kit-confirmation-time'
	candidates: SignupGapPreviewCandidate[]
}

export type SignupGapPreviewOutput = Omit<SignupGapPreview, 'candidates'> & {
	candidates: Array<
		Pick<
			SignupGapPreviewCandidate,
			'maskedEmail' | 'createdAt' | 'excludedSynthetic' | 'exclusionReason'
		>
	>
}

export type SignupConfirmationReconciliationPlan = {
	mode: 'signup-confirmation-reconciliation-plan'
	generatedAt: string
	formId: number
	window: SignupGapPreview['window']
	counts: {
		replayable: number
		unconfirmed: number
		excludedSynthetic: number
		planned: number
		deferred: number
	}
	events: Array<SkillsNewsletterSubscribed & { id: string }>
}

export type SignupGapReplayReceipt = {
	mode: 'signup-gap-replay'
	generatedAt: string
	formId: number
	window: SignupGapPreview['window']
	workSeen: number
	workDone: number
	oldestUnservedAgeHours: number | null
	oldestUnservedAt: string | null
	counts: {
		previewed: number
		excludedSynthetic: number
		skippedExisting: number
		emitted: number
	}
	note: string
}

export const SIGNUP_GAP_KIT_FETCH_ATTEMPTS = 3
export const SIGNUP_GAP_KIT_FETCH_BACKOFF_MS = 250

export class SignupGapSourceUnavailableError extends Error {
	readonly source = 'kit' as const
	readonly attempts: number
	readonly statusCode?: number

	constructor(args: { attempts: number; statusCode?: number }) {
		super(
			`Kit signup-gap source unavailable after ${args.attempts} attempts${args.statusCode ? ` (HTTP ${args.statusCode})` : ''}`,
		)
		this.name = 'SignupGapSourceUnavailableError'
		this.attempts = args.attempts
		this.statusCode = args.statusCode
	}
}

export async function fetchKitSignupGapPageWithRetry(args: {
	request: (attempt: number) => Promise<Response>
	maxAttempts?: number
	backoffMs?: number
	sleep?: (milliseconds: number) => Promise<void>
}) {
	const maxAttempts = args.maxAttempts ?? SIGNUP_GAP_KIT_FETCH_ATTEMPTS
	const backoffMs = args.backoffMs ?? SIGNUP_GAP_KIT_FETCH_BACKOFF_MS
	const sleep = args.sleep ?? wait
	if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
		throw new Error('Kit signup-gap fetch attempts must be a positive integer')
	}

	let lastStatusCode: number | undefined
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const response = await args.request(attempt)
			if (response.status < 500 || response.status > 599) return response
			lastStatusCode = response.status
		} catch {
			lastStatusCode = undefined
		}

		if (attempt < maxAttempts) {
			await sleep(backoffMs * 2 ** (attempt - 1))
		}
	}

	throw new SignupGapSourceUnavailableError({
		attempts: maxAttempts,
		statusCode: lastStatusCode,
	})
}

const SYNTHETIC_LOCAL_PREFIXES = [
	'joel+aih-warmup-synth-',
	'joel+aih-synth-',
] as const

export function buildSignupGapPreview(args: {
	subscribers: SignupGapKitSubscriber[]
	identityMatches: SignupGapIdentityMatches
	formId: number
	from: string
	to: string
	now?: string
}): SignupGapPreview {
	const window = parseSignupGapWindow(args.from, args.to)
	const inWindow = args.subscribers.filter((subscriber) => {
		const addedAt = Date.parse(subscriber.addedAt)
		if (Number.isNaN(addedAt)) {
			throw new Error(
				`Kit subscriber ${subscriber.kitSubscriberId} has an invalid added_at timestamp`,
			)
		}
		return addedAt >= window.fromMs && addedAt < window.toMs
	})

	const stateBreakdown = {
		active: inWindow.filter((subscriber) => subscriber.state === 'active')
			.length,
		inactiveUnconfirmed: inWindow.filter(
			(subscriber) => subscriber.state === 'inactive',
		).length,
		cancelled: inWindow.filter((subscriber) => subscriber.state === 'cancelled')
			.length,
		bounced: inWindow.filter((subscriber) => subscriber.state === 'bounced')
			.length,
		complained: inWindow.filter(
			(subscriber) => subscriber.state === 'complained',
		).length,
	}
	let withExistingContact = 0
	let withExistingProviderIdentity = 0
	let withExistingIdentity = 0
	let withExistingCourseEntry = 0
	const candidates: SignupGapPreviewCandidate[] = []

	for (const subscriber of inWindow) {
		if (subscriber.state !== 'active') continue
		const email = normalizeSignupGapEmail(subscriber.email)
		if (!email) {
			throw new Error(
				`Kit subscriber ${subscriber.kitSubscriberId} has an invalid email address`,
			)
		}
		const hasContact = args.identityMatches.contactEmails.has(email)
		const hasProviderIdentity = args.identityMatches.kitSubscriberIds.has(
			subscriber.kitSubscriberId,
		)
		if (hasContact) withExistingContact += 1
		if (hasProviderIdentity) withExistingProviderIdentity += 1
		if (hasContact || hasProviderIdentity) withExistingIdentity += 1
		if (
			args.identityMatches.courseEntryKitSubscriberIds.has(
				subscriber.kitSubscriberId,
			)
		) {
			withExistingCourseEntry += 1
			continue
		}

		const excludedSynthetic = isSyntheticSignupGapEmail(email)
		const optInAttribution = parseStashedOptInAttribution(subscriber.fields)
		candidates.push({
			kitSubscriberId: subscriber.kitSubscriberId,
			email,
			firstName: subscriber.firstName,
			createdAt: new Date(subscriber.createdAt).toISOString(),
			addedAt: new Date(subscriber.addedAt).toISOString(),
			maskedEmail: maskSignupGapEmail(email),
			excludedSynthetic,
			...(excludedSynthetic
				? { exclusionReason: 'synthetic-address' as const }
				: {}),
			...(optInAttribution ? { optInAttribution } : {}),
		})
	}

	const excludedSynthetic = candidates.filter(
		(candidate) => candidate.excludedSynthetic,
	).length
	const generatedAt = new Date(
		args.now ?? new Date().toISOString(),
	).toISOString()
	const liveness = signupGapLiveness(candidates, generatedAt)
	return {
		mode: 'signup-gap-preview',
		generatedAt,
		formId: args.formId,
		window: { from: window.from, to: window.to },
		counts: {
			kitFormSubscribersFetched: args.subscribers.length,
			inWindow: inWindow.length,
			withExistingContact,
			withExistingProviderIdentity,
			withExistingIdentity,
			withExistingCourseEntry,
			gapCandidates: candidates.length,
			excludedSynthetic,
			unconfirmed: stateBreakdown.inactiveUnconfirmed,
			replayable: candidates.length - excludedSynthetic,
			stateBreakdown,
		},
		...liveness,
		candidates,
	}
}

export function signupGapPreviewForOutput(
	preview: SignupGapPreview,
): SignupGapPreviewOutput {
	return {
		...preview,
		candidates: preview.candidates.map(
			({ maskedEmail, createdAt, excludedSynthetic, exclusionReason }) => ({
				maskedEmail,
				createdAt,
				excludedSynthetic,
				...(exclusionReason ? { exclusionReason } : {}),
			}),
		),
	}
}

export function buildSignupConfirmationReconciliationPlan(args: {
	preview: SignupGapPreview
	limit: number
	source?: string
}): SignupConfirmationReconciliationPlan {
	if (!Number.isInteger(args.limit) || args.limit < 1) {
		throw new Error(
			'Confirmation reconciliation limit must be a positive integer',
		)
	}
	const replayable = args.preview.candidates.filter(
		(candidate) => !candidate.excludedSynthetic,
	)
	const planned = replayable.slice(0, args.limit)
	return {
		mode: 'signup-confirmation-reconciliation-plan',
		generatedAt: args.preview.generatedAt,
		formId: args.preview.formId,
		window: args.preview.window,
		counts: {
			replayable: replayable.length,
			unconfirmed: args.preview.counts.unconfirmed,
			excludedSynthetic: args.preview.counts.excludedSynthetic,
			planned: planned.length,
			deferred: Math.max(0, replayable.length - planned.length),
		},
		events: planned.map((candidate) => ({
			id: `skills-confirmed:${args.preview.formId}:${candidate.kitSubscriberId}`,
			name: SKILLS_NEWSLETTER_SUBSCRIBED_EVENT,
			data: {
				kitSubscriberId: candidate.kitSubscriberId,
				email: candidate.email,
				name: candidate.firstName,
				formId: args.preview.formId,
				source: args.source ?? 'kit-confirmation-reconciler',
				subscribedAt: candidate.addedAt,
				...(candidate.optInAttribution
					? { optInAttribution: candidate.optInAttribution }
					: {}),
			},
		})),
	}
}

export async function replaySignupGap(args: {
	preview: SignupGapPreview
	source?: string
	hasExistingCourseEntry: (
		candidate: SignupGapPreviewCandidate,
	) => Promise<boolean>
	emit: (event: SkillsNewsletterSubscribed) => Promise<unknown>
}): Promise<SignupGapReplayReceipt> {
	let excludedSynthetic = 0
	let skippedExisting = 0
	let emitted = 0
	const candidatesToEmit: SignupGapPreviewCandidate[] = []

	for (const candidate of args.preview.candidates) {
		if (candidate.excludedSynthetic) {
			excludedSynthetic += 1
			continue
		}
		if (await args.hasExistingCourseEntry(candidate)) {
			skippedExisting += 1
			continue
		}
		candidatesToEmit.push(candidate)
	}

	const workSeen = args.preview.workSeen
	for (const [index, candidate] of candidatesToEmit.entries()) {
		const remaining = signupGapLiveness(
			candidatesToEmit.slice(index + 1),
			args.preview.generatedAt,
		)
		await args.emit({
			name: SKILLS_NEWSLETTER_SUBSCRIBED_EVENT,
			data: {
				kitSubscriberId: candidate.kitSubscriberId,
				email: candidate.email,
				name: candidate.firstName,
				formId: args.preview.formId,
				source: args.source ?? 'signup-gap-replay',
				subscribedAt: candidate.addedAt,
				...(candidate.optInAttribution
					? { optInAttribution: candidate.optInAttribution }
					: {}),
				signupGapLiveness: {
					workSeen,
					workDone: skippedExisting + emitted + 1,
					oldestUnservedAgeHours: remaining.oldestUnservedAgeHours,
					oldestUnservedAt: remaining.oldestUnservedAt,
				},
			},
		})
		emitted += 1
	}

	return {
		mode: 'signup-gap-replay',
		generatedAt: args.preview.generatedAt,
		formId: args.preview.formId,
		window: args.preview.window,
		workSeen,
		workDone: skippedExisting + emitted,
		oldestUnservedAgeHours: null,
		oldestUnservedAt: null,
		counts: {
			previewed: args.preview.counts.gapCandidates,
			excludedSynthetic,
			skippedExisting,
			emitted,
		},
		note: 'Each emitted replay enters the live drip and leads to a real email-0 send.',
	}
}

function signupGapLiveness(
	candidates: readonly SignupGapPreviewCandidate[],
	generatedAt: string,
) {
	const replayable = candidates.filter(
		(candidate) => !candidate.excludedSynthetic,
	)
	const oldestCandidateSubscriberCreatedAt =
		replayable.map((candidate) => candidate.createdAt).sort()[0] ?? null
	return {
		workSeen: replayable.length,
		workDone: 0,
		// Kit's form-subscriber payload exposes subscriber creation time, not the
		// inactive -> active transition time. Treating createdAt as confirmation
		// time made a candidate first seen before a sweep look hours overdue.
		oldestUnservedAgeHours: null,
		oldestUnservedAt: null,
		oldestCandidateSubscriberAgeHours:
			oldestCandidateSubscriberCreatedAt === null
				? null
				: Math.max(
						0,
						(Date.parse(generatedAt) -
							Date.parse(oldestCandidateSubscriberCreatedAt)) /
							(60 * 60 * 1000),
					),
		oldestCandidateSubscriberCreatedAt,
		unservedAgeBasis: 'unavailable-kit-confirmation-time' as const,
	}
}

export function isSyntheticSignupGapEmail(email: string) {
	const local = normalizeSignupGapEmail(email)?.split('@')[0]
	return Boolean(
		local &&
		SYNTHETIC_LOCAL_PREFIXES.some((prefix) => local.startsWith(prefix)),
	)
}

export function maskSignupGapEmail(email: string) {
	const normalized = normalizeSignupGapEmail(email)
	if (!normalized) return '<invalid-email>'
	const [local = '', domain = ''] = normalized.split('@')
	return `${local.slice(0, 2)}***@${domain}`
}

export function normalizeSignupGapEmail(email?: string | null) {
	const normalized = email?.trim().toLowerCase()
	if (!normalized) return undefined
	const at = normalized.lastIndexOf('@')
	if (at < 1 || at === normalized.length - 1) return undefined
	return normalized
}

function wait(milliseconds: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

function parseSignupGapWindow(from: string, to: string) {
	const fromMs = Date.parse(from)
	const toMs = Date.parse(to)
	if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs >= toMs) {
		throw new Error(
			'--from and --to must be valid timestamps with --from before --to',
		)
	}
	return {
		from: new Date(fromMs).toISOString(),
		to: new Date(toMs).toISOString(),
		fromMs,
		toMs,
	}
}
