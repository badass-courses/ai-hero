import {
	SKILLS_NEWSLETTER_SUBSCRIBED_EVENT,
	type SkillsNewsletterSubscribed,
} from '@/inngest/events/skills-newsletter'

export type SignupGapKitSubscriber = {
	kitSubscriberId: string
	email: string
	firstName?: string
	createdAt: string
	fields?: Record<string, unknown>
}

export type SignupGapIdentityMatches = {
	contactEmails: ReadonlySet<string>
	kitSubscriberIds: ReadonlySet<string>
}

export type SignupGapPreviewCandidate = {
	kitSubscriberId: string
	email: string
	firstName?: string
	createdAt: string
	maskedEmail: string
	excludedSynthetic: boolean
	exclusionReason?: 'synthetic-address'
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
		gapCandidates: number
		excludedSynthetic: number
		replayable: number
	}
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

export type SignupGapReplayReceipt = {
	mode: 'signup-gap-replay'
	formId: number
	window: SignupGapPreview['window']
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
		const createdAt = Date.parse(subscriber.createdAt)
		if (Number.isNaN(createdAt)) {
			throw new Error(
				`Kit subscriber ${subscriber.kitSubscriberId} has an invalid created_at timestamp`,
			)
		}
		return createdAt >= window.fromMs && createdAt < window.toMs
	})

	let withExistingContact = 0
	let withExistingProviderIdentity = 0
	let withExistingIdentity = 0
	const candidates: SignupGapPreviewCandidate[] = []

	for (const subscriber of inWindow) {
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
		if (hasContact || hasProviderIdentity) {
			withExistingIdentity += 1
			continue
		}

		const excludedSynthetic = isSyntheticSignupGapEmail(email)
		candidates.push({
			kitSubscriberId: subscriber.kitSubscriberId,
			email,
			firstName: subscriber.firstName,
			createdAt: new Date(subscriber.createdAt).toISOString(),
			maskedEmail: maskSignupGapEmail(email),
			excludedSynthetic,
			...(excludedSynthetic
				? { exclusionReason: 'synthetic-address' as const }
				: {}),
		})
	}

	const excludedSynthetic = candidates.filter(
		(candidate) => candidate.excludedSynthetic,
	).length
	return {
		mode: 'signup-gap-preview',
		generatedAt: new Date(args.now ?? new Date().toISOString()).toISOString(),
		formId: args.formId,
		window: { from: window.from, to: window.to },
		counts: {
			kitFormSubscribersFetched: args.subscribers.length,
			inWindow: inWindow.length,
			withExistingContact,
			withExistingProviderIdentity,
			withExistingIdentity,
			gapCandidates: candidates.length,
			excludedSynthetic,
			replayable: candidates.length - excludedSynthetic,
		},
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

export async function replaySignupGap(args: {
	preview: SignupGapPreview
	source?: string
	hasExistingIdentity: (candidate: SignupGapPreviewCandidate) => Promise<boolean>
	emit: (event: SkillsNewsletterSubscribed) => Promise<unknown>
}): Promise<SignupGapReplayReceipt> {
	let excludedSynthetic = 0
	let skippedExisting = 0
	let emitted = 0

	for (const candidate of args.preview.candidates) {
		if (candidate.excludedSynthetic) {
			excludedSynthetic += 1
			continue
		}
		if (await args.hasExistingIdentity(candidate)) {
			skippedExisting += 1
			continue
		}
		await args.emit({
			name: SKILLS_NEWSLETTER_SUBSCRIBED_EVENT,
			data: {
				kitSubscriberId: candidate.kitSubscriberId,
				email: candidate.email,
				name: candidate.firstName,
				formId: args.preview.formId,
				source: args.source ?? 'signup-gap-replay',
				subscribedAt: candidate.createdAt,
			},
		})
		emitted += 1
	}

	return {
		mode: 'signup-gap-replay',
		formId: args.preview.formId,
		window: args.preview.window,
		counts: {
			previewed: args.preview.counts.gapCandidates,
			excludedSynthetic,
			skippedExisting,
			emitted,
		},
		note:
			'Each emitted replay enters the live drip and leads to a real email-0 send.',
	}
}

export function isSyntheticSignupGapEmail(email: string) {
	const local = normalizeSignupGapEmail(email)?.split('@')[0]
	return Boolean(
		local && SYNTHETIC_LOCAL_PREFIXES.some((prefix) => local.startsWith(prefix)),
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
		throw new Error('--from and --to must be valid timestamps with --from before --to')
	}
	return {
		from: new Date(fromMs).toISOString(),
		to: new Date(toMs).toISOString(),
		fromMs,
		toMs,
	}
}
