import { createHash } from 'node:crypto'

import type { ValuePathSendGateMode } from './value-path-send-gate'

export const SKILLS_WORKFLOW_GATE_D_NAMESPACE = 'skills-workflow' as const
export const GATE_D_REDIS_PREFIX = 'aih:gate-d' as const

export type GateDRuntimeAllowlistStatus =
	| 'draft'
	| 'approved'
	| 'active'
	| 'paused'
	| 'rolled_back'

export type GateDAuthorizationMode =
	| 'manual-review-per-send'
	| 'finish-approved-path'
	| 'rolling-public-enrollment'

export type GateDAllowedAction =
	| 'send-path-emails'
	| 'advance-by-answer-click'
	| 'advance-by-daily-drip'
	| 'retry-transient-provider-failures'
	| 'finish-full-approved-path'

export type GateDRetryPolicy = {
	providerRetryDelayMinutes: number
	maxProviderRetryAttempts: number
}

export const DEFAULT_GATE_D_PREAUTHORIZED_REVIEW_REASONS = [
	'human-review',
] as const

export const DEFAULT_GATE_D_ALLOWED_ACTIONS = [
	'send-path-emails',
	'advance-by-answer-click',
	'advance-by-daily-drip',
	'retry-transient-provider-failures',
	'finish-full-approved-path',
] satisfies GateDAllowedAction[]

export const DEFAULT_GATE_D_STOP_REASONS = [
	'contact-not-allowlisted',
	'kit-subscriber-not-allowlisted',
	'email-not-allowlisted',
	'value-path-not-allowlisted',
	'email-resource-not-allowlisted',
	'kit-sequence-not-allowlisted',
	'value-path-not-enabled',
	'email-resource-not-verified',
	'kit-sequence-not-verified',
	'contact-missing',
	'contact-state-missing',
	'contact-email-missing',
	'kit-sequence-missing',
	'email-resource-missing',
	'value-path-missing',
	'suppressed',
	'stale-state',
	'unsubscribed',
	'bounced',
	'complained',
	'identity-conflict',
	'support-intent',
	'team-sales-intent',
	'partnership-intent',
	'sponsorship-intent',
	'emotional-signal',
	'restricted-payload',
	'answer-pages-missing',
	'value-path-base-url-missing',
	'path-token-secret-missing',
	'kit-sequence-enrollment-failed',
] as const

export const DEFAULT_GATE_D_RETRY_POLICY: GateDRetryPolicy = {
	providerRetryDelayMinutes: 15,
	maxProviderRetryAttempts: 5,
}

export const DEFAULT_GATE_D_MAX_SENDS_PER_RUN = 25

export type GateDScheduleEvidence = {
	timezone?: string
	source?: 'browser' | 'vercel-geo' | 'fallback-24h'
	country?: string
	region?: string
	city?: string
}

export type GateDAllowlistCandidate = {
	contactId: string
	kitSubscriberId?: string
	email?: string
	emailHash?: string
	domain?: string
	scheduleEvidence?: GateDScheduleEvidence
	rationale: string[]
	blockers: string[]
}

export type GateDRuntimeAllowlist = {
	activationId: string
	name?: string
	status: GateDRuntimeAllowlistStatus
	killSwitch: boolean
	mode: ValuePathSendGateMode
	authorizationMode?: GateDAuthorizationMode
	pathSlugs: string[]
	contactIds: string[]
	kitSubscriberIds: string[]
	emails: string[]
	emailHashes: string[]
	emailResourceIds: string[]
	kitSequenceIds: string[]
	candidates: GateDAllowlistCandidate[]
	allowedActions?: GateDAllowedAction[]
	preAuthorizedReviewReasons?: string[]
	stopFor?: string[]
	retryPolicy?: GateDRetryPolicy
	maxSendsPerRun?: number
	createdBy?: string
	approvedBy?: string
	approvedAt?: string
	createdAt: string
	updatedAt?: string
	receipts?: string[]
}

export type GateDRuntimeAllowlistDecision = {
	passed: boolean
	reviewReasons: string[]
	rationale: string[]
	allowlist?: GateDRuntimeAllowlist
}

type GateDRedisClient = {
	get<T = unknown>(key: string): Promise<T | null> | T | null
	set(key: string, value: unknown): Promise<unknown> | unknown
	del?(key: string): Promise<unknown> | unknown
}

export function gateDActivePointerKey(
	namespace: string = SKILLS_WORKFLOW_GATE_D_NAMESPACE,
) {
	return `${GATE_D_REDIS_PREFIX}:${namespace}:active`
}

export function gateDActivationObjectKey(
	activationId: string,
	namespace: string = SKILLS_WORKFLOW_GATE_D_NAMESPACE,
) {
	return `${GATE_D_REDIS_PREFIX}:${namespace}:${activationId}`
}

export async function writeGateDRuntimeAllowlist(args: {
	redis: GateDRedisClient
	allowlist: GateDRuntimeAllowlist
	namespace?: string
	activate?: boolean
}) {
	const namespace = args.namespace ?? SKILLS_WORKFLOW_GATE_D_NAMESPACE
	const normalized = normalizeGateDRuntimeAllowlist(args.allowlist)
	await args.redis.set(
		gateDActivationObjectKey(normalized.activationId, namespace),
		normalized,
	)
	if (args.activate || normalized.status === 'active') {
		await args.redis.set(
			gateDActivePointerKey(namespace),
			normalized.activationId,
		)
	}
	return normalized
}

export async function readActiveGateDRuntimeAllowlist(args: {
	redis: GateDRedisClient
	namespace?: string
}): Promise<GateDRuntimeAllowlistDecision> {
	const namespace = args.namespace ?? SKILLS_WORKFLOW_GATE_D_NAMESPACE
	const activationId = await args.redis.get<string>(
		gateDActivePointerKey(namespace),
	)
	if (!activationId) {
		return block('gate-d-allowlist-missing')
	}
	const allowlist = await args.redis.get<GateDRuntimeAllowlist>(
		gateDActivationObjectKey(activationId, namespace),
	)
	if (!allowlist) {
		return block('gate-d-allowlist-object-missing')
	}
	return evaluateGateDRuntimeAllowlistStatus(
		normalizeGateDRuntimeAllowlist(allowlist),
	)
}

export function evaluateGateDRuntimeAllowlistStatus(
	allowlist: GateDRuntimeAllowlist,
): GateDRuntimeAllowlistDecision {
	if (allowlist.killSwitch)
		return block('gate-d-allowlist-kill-switch', allowlist)
	if (allowlist.status !== 'active') {
		return block(`gate-d-allowlist-${allowlist.status}`, allowlist)
	}
	return {
		passed: true,
		reviewReasons: [],
		rationale: [
			'Gate D Runtime Allowlist is active.',
			allowlist.authorizationMode === 'finish-approved-path'
				? 'Path cohort authorization is pre-approved to finish.'
				: allowlist.authorizationMode === 'rolling-public-enrollment'
					? 'Explicit public signups may enter continuously; path and email assets remain allowlisted.'
					: 'Path cohort authorization requires per-send review acceptance.',
		],
		allowlist,
	}
}

export function evaluateGateDRuntimeAllowlist(args: {
	allowlist: GateDRuntimeAllowlist
	contactId: string
	kitSubscriberId?: string
	email?: string
	valuePathSlug: string
	emailResourceId: string
	kitSequenceId?: string
}): GateDRuntimeAllowlistDecision {
	const status = evaluateGateDRuntimeAllowlistStatus(args.allowlist)
	if (!status.passed) return status

	const normalizedEmail = normalizeEmail(args.email)
	const emailHash = normalizedEmail ? hashEmail(normalizedEmail) : undefined
	const rollingEnrollment =
		args.allowlist.authorizationMode === 'rolling-public-enrollment'
	const reviewReasons = [
		...(rollingEnrollment || args.allowlist.contactIds.includes(args.contactId)
			? []
			: ['contact-not-allowlisted']),
		...(rollingEnrollment ||
		(args.kitSubscriberId &&
			args.allowlist.kitSubscriberIds.includes(args.kitSubscriberId))
			? []
			: ['kit-subscriber-not-allowlisted']),
		...(rollingEnrollment ||
		(normalizedEmail &&
			(args.allowlist.emails.includes(normalizedEmail) ||
				(emailHash && args.allowlist.emailHashes.includes(emailHash))))
			? []
			: ['email-not-allowlisted']),
		...(args.allowlist.pathSlugs.includes(args.valuePathSlug)
			? []
			: ['value-path-not-allowlisted']),
		...(args.allowlist.emailResourceIds.includes(args.emailResourceId)
			? []
			: ['email-resource-not-allowlisted']),
		...(args.kitSequenceId &&
		args.allowlist.kitSequenceIds.includes(args.kitSequenceId)
			? []
			: ['kit-sequence-not-allowlisted']),
	]
	return {
		passed: reviewReasons.length === 0,
		reviewReasons,
		rationale:
			reviewReasons.length === 0
				? ['Contact and value path email are allowlisted for Gate D.']
				: [],
		allowlist: args.allowlist,
	}
}

export function normalizeGateDRuntimeAllowlist(
	allowlist: GateDRuntimeAllowlist,
): GateDRuntimeAllowlist {
	const emails = unique(
		allowlist.emails.map(normalizeEmail).filter(Boolean) as string[],
	)
	const candidateEmails = allowlist.candidates
		.map((candidate) => normalizeEmail(candidate.email))
		.filter(Boolean) as string[]
	const allEmails = unique([...emails, ...candidateEmails])
	const allEmailHashes = unique([
		...allowlist.emailHashes,
		...allEmails.map(hashEmail),
		...allowlist.candidates
			.map((candidate) => candidate.emailHash)
			.filter(Boolean),
	] as string[])
	return {
		...allowlist,
		name: allowlist.name ?? allowlist.activationId,
		authorizationMode: allowlist.authorizationMode ?? 'finish-approved-path',
		allowedActions: unique(
			allowlist.allowedActions ?? [...DEFAULT_GATE_D_ALLOWED_ACTIONS],
		),
		preAuthorizedReviewReasons: unique(
			allowlist.preAuthorizedReviewReasons ?? [
				...DEFAULT_GATE_D_PREAUTHORIZED_REVIEW_REASONS,
			],
		),
		stopFor: unique(allowlist.stopFor ?? [...DEFAULT_GATE_D_STOP_REASONS]),
		retryPolicy: {
			...DEFAULT_GATE_D_RETRY_POLICY,
			...(allowlist.retryPolicy ?? {}),
		},
		maxSendsPerRun:
			allowlist.maxSendsPerRun ?? DEFAULT_GATE_D_MAX_SENDS_PER_RUN,
		updatedAt: allowlist.updatedAt ?? allowlist.createdAt,
		contactIds: unique([
			...allowlist.contactIds,
			...allowlist.candidates.map((candidate) => candidate.contactId),
		]),
		kitSubscriberIds: unique([
			...allowlist.kitSubscriberIds,
			...allowlist.candidates
				.map((candidate) => candidate.kitSubscriberId)
				.filter(Boolean),
		] as string[]),
		emails: allEmails,
		emailHashes: allEmailHashes,
		pathSlugs: unique(allowlist.pathSlugs),
		emailResourceIds: unique(allowlist.emailResourceIds),
		kitSequenceIds: unique(allowlist.kitSequenceIds),
		candidates: allowlist.candidates.map((candidate) => {
			const email = normalizeEmail(candidate.email)
			return {
				...candidate,
				email,
				emailHash:
					candidate.emailHash ?? (email ? hashEmail(email) : undefined),
				domain: candidate.domain ?? emailDomain(email),
			}
		}),
	}
}

export function normalizeEmail(email?: string | null) {
	const normalized = email?.trim().toLowerCase()
	return normalized && normalized.includes('@') ? normalized : undefined
}

export function emailDomain(email?: string | null) {
	return normalizeEmail(email)?.split('@')[1]
}

export function hashEmail(email: string) {
	return `sha256:${createHash('sha256')
		.update(normalizeEmail(email) ?? email)
		.digest('hex')}`
}

export function redactEmail(email?: string | null) {
	const normalized = normalizeEmail(email)
	if (!normalized) return undefined
	const [local = '', domain = ''] = normalized.split('@')
	if (!domain) return '<redacted>'
	return `${local.slice(0, 1)}***@${domain}`
}

export function resolveGateDPreAuthorizedReviewReasons(args: {
	allowlist?: GateDRuntimeAllowlist
	explicitReviewReasons?: readonly string[]
	legacyEnvReviewReasons?: readonly string[]
}) {
	const allowlist = args.allowlist
		? normalizeGateDRuntimeAllowlist(args.allowlist)
		: undefined
	const stopFor = new Set(allowlist?.stopFor ?? DEFAULT_GATE_D_STOP_REASONS)
	const allowlistReasons =
		allowlist?.authorizationMode === 'finish-approved-path'
			? (allowlist.preAuthorizedReviewReasons ?? [])
			: []
	return unique([
		...allowlistReasons,
		...(args.explicitReviewReasons ?? []),
		...(args.legacyEnvReviewReasons ?? []),
	]).filter((reason) => !stopFor.has(reason))
}

export function gateDActionReviewReasons(args: {
	allowlist?: GateDRuntimeAllowlist
	allowedActions?: readonly string[]
	requiredActions: readonly GateDAllowedAction[]
}) {
	const allowedActions = args.allowlist
		? normalizeGateDRuntimeAllowlist(args.allowlist).allowedActions
		: args.allowedActions
	if (!allowedActions) return []
	return args.requiredActions.flatMap((action) =>
		allowedActions.includes(action)
			? []
			: [`authorization-action-not-allowed:${action}`],
	)
}

function block(
	reason: string,
	allowlist?: GateDRuntimeAllowlist,
): GateDRuntimeAllowlistDecision {
	return {
		passed: false,
		reviewReasons: [reason],
		rationale: [],
		allowlist,
	}
}

function unique<T>(items: T[]) {
	return Array.from(new Set(items))
}
