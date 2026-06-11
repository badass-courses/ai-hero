import type { ContactLifecycle, ReviewSignalSlug } from './types'
import {
	emailDomain,
	hashEmail,
	normalizeEmail,
	redactEmail,
	type GateDScheduleEvidence,
} from './value-path-gate-d-allowlist'

export type SkillsFormSubscriberEvidence = {
	kitSubscriberId: string
	email: string
	subscribedAt?: string
	fields?: Record<string, unknown>
	scheduleEvidence?: GateDScheduleEvidence
}

export type QuickQuestionReplyEvidence = {
	contactId: string
	email: string
	occurredAt: string
	lifecycle?: ContactLifecycle
	humanReview?: boolean
	reviewSignals?: ReviewSignalSlug[]
}

export type ContactMatchEvidence = {
	contactId: string
	email: string
	lifecycle?: ContactLifecycle
	humanReview?: boolean
	reviewSignals?: ReviewSignalSlug[]
	alreadyCompletedPath?: boolean
}

export type GateDCandidatePreviewItem = {
	redactedEmail?: string
	email?: string
	contactId?: string
	kitSubscriberId?: string
	emailHash?: string
	domain?: string
	rationale: string[]
	blockers: string[]
	scheduleEvidence?: GateDScheduleEvidence
	sourceEvidence: {
		skillsForm: boolean
		quickQuestionReply: boolean
		contactMatch: boolean
		skillsFormSubscribedAt?: string
		quickQuestionOccurredAt?: string
	}
}

export type GateDCandidatePreview = {
	mode: 'gate-d-candidate-preview'
	recentDays: number
	targetCount: number
	generatedAt: string
	counts: {
		skillsFormSubscribers: number
		quickQuestionReplies: number
		candidates: number
		blocked: number
	}
	candidates: GateDCandidatePreviewItem[]
	blocked: GateDCandidatePreviewItem[]
	warnings: string[]
}

export function previewValuePathGateDCandidates(args: {
	skillsFormSubscribers: SkillsFormSubscriberEvidence[]
	quickQuestionReplies: QuickQuestionReplyEvidence[]
	contactMatches?: ContactMatchEvidence[]
	requireQuickQuestionReply?: boolean
	now?: string
	recentDays?: number
	targetCount?: number
	includeEmails?: boolean
}): GateDCandidatePreview {
	const now = new Date(args.now ?? new Date().toISOString())
	const recentDays = args.recentDays ?? 14
	const targetCount = args.targetCount ?? 20
	const sinceMs = now.getTime() - recentDays * 24 * 60 * 60 * 1000
	const quickQuestionByEmail = new Map<string, QuickQuestionReplyEvidence>()
	const contactByEmail = new Map<string, ContactMatchEvidence>()

	for (const reply of args.quickQuestionReplies) {
		const email = normalizeEmail(reply.email)
		if (!email) continue
		const existing = quickQuestionByEmail.get(email)
		if (!existing || existing.occurredAt < reply.occurredAt) {
			quickQuestionByEmail.set(email, reply)
		}
	}

	for (const match of args.contactMatches ?? []) {
		const email = normalizeEmail(match.email)
		if (!email) continue
		const existing = contactByEmail.get(email)
		if (!existing) contactByEmail.set(email, match)
	}

	const candidates: GateDCandidatePreviewItem[] = []
	const blocked: GateDCandidatePreviewItem[] = []
	const warnings: string[] = []

	for (const subscriber of args.skillsFormSubscribers) {
		const email = normalizeEmail(subscriber.email)
		const reply = email ? quickQuestionByEmail.get(email) : undefined
		const contactMatch = email ? contactByEmail.get(email) : undefined
		const item = buildPreviewItem({
			subscriber,
			reply,
			contactMatch,
			requireQuickQuestionReply: args.requireQuickQuestionReply ?? true,
			sinceMs,
			includeEmail: args.includeEmails ?? false,
		})
		if (item.blockers.length > 0) {
			blocked.push(item)
		} else {
			candidates.push(item)
		}
	}

	if (candidates.length < targetCount) {
		warnings.push(
			`candidate-count-below-target:${candidates.length}:${targetCount}`,
		)
	}

	return {
		mode: 'gate-d-candidate-preview',
		recentDays,
		targetCount,
		generatedAt: now.toISOString(),
		counts: {
			skillsFormSubscribers: args.skillsFormSubscribers.length,
			quickQuestionReplies: args.quickQuestionReplies.length,
			candidates: candidates.length,
			blocked: blocked.length,
		},
		candidates: candidates.slice(0, targetCount),
		blocked,
		warnings,
	}
}

function buildPreviewItem(args: {
	subscriber: SkillsFormSubscriberEvidence
	reply?: QuickQuestionReplyEvidence
	contactMatch?: ContactMatchEvidence
	requireQuickQuestionReply: boolean
	sinceMs: number
	includeEmail: boolean
}): GateDCandidatePreviewItem {
	const email = normalizeEmail(args.subscriber.email)
	const subscribedAt = args.subscriber.subscribedAt
	const reviewSignals =
		args.reply?.reviewSignals ?? args.contactMatch?.reviewSignals ?? []
	const lifecycle = args.reply?.lifecycle ?? args.contactMatch?.lifecycle
	const humanReview = args.reply?.humanReview ?? args.contactMatch?.humanReview
	const blockers = [
		...(email ? [] : ['email-missing']),
		...(subscribedAt ? [] : ['skills-form-subscribed-at-missing']),
		...(subscribedAt && Date.parse(subscribedAt) >= args.sinceMs
			? []
			: ['skills-form-not-recent']),
		...(args.requireQuickQuestionReply && !args.reply
			? ['quick-question-reply-missing']
			: []),
		...(args.requireQuickQuestionReply &&
		args.reply?.occurredAt &&
		Date.parse(args.reply.occurredAt) < args.sinceMs
			? ['quick-question-reply-not-recent']
			: []),
		...(humanReview ? ['human-review'] : []),
		...(lifecycle === 'suppressed' ? ['suppressed'] : []),
		...(lifecycle === 'stale' ? ['stale-state'] : []),
		...(args.contactMatch?.alreadyCompletedPath
			? ['already-completed-value-path']
			: []),
		...(reviewSignals.includes('team-sales') ? ['team-sales-intent'] : []),
		...(reviewSignals.includes('support') ? ['support-intent'] : []),
		...(reviewSignals.includes('partnership') ? ['partnership-intent'] : []),
		...(reviewSignals.includes('sponsorship') ? ['sponsorship-intent'] : []),
		...(reviewSignals.includes('restricted-payload')
			? ['restricted-payload']
			: []),
		...(reviewSignals.includes('emotional') ? ['emotional-signal'] : []),
	]
	return {
		redactedEmail: redactEmail(email),
		email: args.includeEmail ? email : undefined,
		contactId: args.reply?.contactId ?? args.contactMatch?.contactId,
		kitSubscriberId: args.subscriber.kitSubscriberId,
		emailHash: email ? hashEmail(email) : undefined,
		domain: emailDomain(email),
		rationale: [
			...(subscribedAt ? ['skills-form'] : []),
			...(args.reply ? ['quick-question-reply'] : []),
			...(args.contactMatch ? ['contact-match'] : []),
		],
		blockers,
		scheduleEvidence: args.subscriber.scheduleEvidence,
		sourceEvidence: {
			skillsForm: Boolean(subscribedAt),
			quickQuestionReply: Boolean(args.reply),
			contactMatch: Boolean(args.contactMatch),
			skillsFormSubscribedAt: subscribedAt,
			quickQuestionOccurredAt: args.reply?.occurredAt,
		},
	}
}
