import {
	classifyLearnerFlowContact,
	type LearnerFlowStuckCause,
} from './learner-flow-classifier'
import {
	queryLearnerFlowCohort,
	type LearnerFlowCohortRecord,
	type LearnerFlowCohortRepository,
} from './learner-flow-cohort'
import {
	learnerFlowDrillSuppression,
	type LearnerFlowDrillSuppression,
} from './learner-flow-drill'
import { learnerFlowUnstickAction } from './learner-flow-unstick'
import type { GateDRuntimeAllowlist } from './value-path-gate-d-allowlist'
import {
	progressValuePathDrips,
	type ValuePathDripProgressionRepository,
	type ValuePathDripProgressionResult,
} from './value-path-drip-progression'
import {
	replanBlockedValuePathEmailIntents,
	type IntentReplanRepository,
	type IntentReplanResult,
} from './value-path-intent-replan'
import {
	repairValuePathCompletionFacts,
	valuePathCompletionRepairEvidence,
	type ValuePathCompletedAtBackfillRepository,
	type ValuePathCompletionRepairEvidence,
	type ValuePathCompletionRepairResult,
} from './value-path-completed-at-backfill'

/**
 * The hourly reconciler repairs local state and creates or reopens pending
 * intents. It never calls Kit. The five-minute executor is the single sender
 * and discovers this work through its generic pending-intent scan.
 *
 * repairCap bounds local mutations. The ratio wall stops classifier corruption
 * before any database write. Change either value only with receipt evidence.
 */
export type LearnerFlowReconcilerConfig = {
	repairCap: number
	maxRepairToCohortRatio: number
}

export const LEARNER_FLOW_RECONCILER_CONFIG: LearnerFlowReconcilerConfig = {
	repairCap: 150,
	maxRepairToCohortRatio: 0.25,
}

export type LearnerFlowReconcilerCandidate = {
	contactId: string
	intentId: string
	action:
		| 'replan-blocked-intent'
		| 'nudge-drip-progression'
		| 'repair-completion-and-nudge-drip'
	repairEvidence?: ValuePathCompletionRepairEvidence
	cause: LearnerFlowStuckCause
	stage: string
	stuckAgeHours?: number
	lastActivityAt?: string
}

export type LearnerFlowReconcilerTier2Ask = {
	contactId: string
	intentId?: string
	cause: LearnerFlowStuckCause
	stage: string
	stuckAgeHours?: number
	lastActivityAt?: string
}

export type LearnerFlowReconcilerPlan = {
	generatedAt: string
	cohort: {
		source: 'live-rolling-learner-flow' | 'live-finish-approved-path'
		contacts: number
		liveRecordsScanned: number
		includesCanary: true
	}
	counts: {
		moving: number
		terminal: number
		stuck: number
		planned: number
		suppressedFixtureStarved: number
		tier2: number
	}
	causeCounts: Partial<Record<LearnerFlowStuckCause, number>>
	candidates: LearnerFlowReconcilerCandidate[]
	suppressedFixtureStarved: LearnerFlowDrillSuppression[]
	tier2: LearnerFlowReconcilerTier2Ask[]
	records: LearnerFlowCohortRecord[]
}

export type LearnerFlowReconcilerBrake = {
	status: 'clear' | 'tripped'
	reasons: string[]
	repairToCohortRatio: number
	repairCap: number
	maxRepairToCohortRatio: number
}

export type LearnerFlowReconcilerRepository = LearnerFlowCohortRepository &
	ValuePathDripProgressionRepository &
	IntentReplanRepository &
	Pick<ValuePathCompletedAtBackfillRepository, 'updateSideEffectIntent'>

export type LearnerFlowReconcilerReceipt = {
	event: 'subscriber_funnel.drip_run_completed'
	receiptVersion: 2
	funnel: 'skills-newsletter'
	loop: 'repair'
	status: 'ok' | 'blocked' | 'degraded'
	workSeen: number
	workDone: number
	oldestUnservedAt: string | null
	oldestUnservedAgeHours: number | null
	counts: {
		completionFactsRepaired: number
		intentsReplanned: number
		intentsCreated: number
		noop: number
		blocked: number
		notDue: number
		failed: number
		deferred: number
		writeFailed: number
		retriesExhausted: number
		permanentProviderFailures: number
		tier2: number
	}
	blockedReasons: Record<string, number>
	failureReasons: string[]
	causeCounts: Partial<Record<LearnerFlowStuckCause, number>>
	brake: {
		status: 'clear' | 'tripped'
		reasons: string[]
	}
}

export async function buildLearnerFlowReconcilerPlan(args: {
	repository: LearnerFlowCohortRepository
	allowlist: GateDRuntimeAllowlist
	now: string
}): Promise<LearnerFlowReconcilerPlan> {
	const cohort = await queryLearnerFlowCohort({
		repository: args.repository,
		allowlist: args.allowlist,
		includeCanary: true,
	})
	const scheduleByContact = new Map(
		args.allowlist.candidates.map((candidate) => [
			candidate.contactId,
			candidate.scheduleEvidence,
		]),
	)
	const classified = cohort.records.map((record) => ({
		record,
		classification: classifyLearnerFlowContact({
			...record,
			now: args.now,
			dripScheduleEvidence: scheduleByContact.get(record.contactId),
		}),
	}))
	const candidates: LearnerFlowReconcilerCandidate[] = []
	const suppressedFixtureStarved: LearnerFlowDrillSuppression[] = []
	const tier2: LearnerFlowReconcilerTier2Ask[] = []
	for (const item of classified) {
		const { classification } = item
		if (classification.state !== 'stuck' || !classification.cause) continue
		const repairEvidence = item.record.intents
			.map(valuePathCompletionRepairEvidence)
			.find(
				(evidence): evidence is ValuePathCompletionRepairEvidence =>
					Boolean(evidence),
			)
		if (repairEvidence && classification.cause === 'classifier-gap') {
			candidates.push({
				contactId: item.record.contactId,
				intentId: repairEvidence.intent.id,
				action: 'repair-completion-and-nudge-drip',
				repairEvidence,
				cause: 'classifier-gap',
				stage:
					stringField(repairEvidence.intent.metadata.emailResourceId) ??
					classification.stage,
				stuckAgeHours: hoursSince(repairEvidence.completedAt, args.now),
				lastActivityAt: repairEvidence.completedAt,
			})
			continue
		}
		const action = learnerFlowUnstickAction(classification.cause)
		if (action !== 'ask-joel' && classification.intentId) {
			if (action === 'nudge-drip-progression') {
				const suppression = learnerFlowDrillSuppression(item.record, args.now)
				if (suppression) {
					suppressedFixtureStarved.push(suppression)
					continue
				}
			}
			candidates.push({
				contactId: item.record.contactId,
				intentId: classification.intentId,
				action,
				cause: classification.cause,
				stage: classification.stage,
				stuckAgeHours: classification.stuckAgeHours,
				lastActivityAt: classification.lastActivityAt,
			})
			continue
		}
		tier2.push({
			contactId: item.record.contactId,
			intentId: classification.intentId,
			cause: classification.cause,
			stage: classification.stage,
			stuckAgeHours: classification.stuckAgeHours,
			lastActivityAt: classification.lastActivityAt,
		})
	}
	candidates.sort(compareCandidateAge)
	const causeCounts = classified.reduce<
		Partial<Record<LearnerFlowStuckCause, number>>
	>((counts, item) => {
		const cause = item.classification.cause
		if (cause) counts[cause] = (counts[cause] ?? 0) + 1
		return counts
	}, {})
	return {
		generatedAt: args.now,
		cohort: {
			source: cohort.source,
			contacts: cohort.contactIds.length,
			liveRecordsScanned: cohort.liveRecordsScanned,
			includesCanary: true,
		},
		counts: {
			moving: classified.filter(
				(item) => item.classification.state === 'moving',
			).length,
			terminal: classified.filter(
				(item) => item.classification.state === 'terminal',
			).length,
			stuck: classified.filter(
				(item) => item.classification.state === 'stuck',
			).length,
			planned: candidates.length,
			suppressedFixtureStarved: suppressedFixtureStarved.length,
			tier2: tier2.length,
		},
		causeCounts,
		candidates,
		suppressedFixtureStarved,
		tier2,
		records: cohort.records,
	}
}

export function evaluateLearnerFlowReconcilerBrake(args: {
	cohortSize: number
	candidates: LearnerFlowReconcilerCandidate[]
	config?: LearnerFlowReconcilerConfig
}): LearnerFlowReconcilerBrake {
	const config = args.config ?? LEARNER_FLOW_RECONCILER_CONFIG
	const riskyRepairCount = args.candidates.filter(
		(candidate) => candidate.action !== 'nudge-drip-progression',
	).length
	const repairToCohortRatio =
		args.cohortSize > 0 ? riskyRepairCount / args.cohortSize : 0
	const reasons =
		args.cohortSize > 0 &&
		repairToCohortRatio > config.maxRepairToCohortRatio
			? [
					`repair-ratio-${formatRatio(repairToCohortRatio)}-exceeds-${formatRatio(config.maxRepairToCohortRatio)}`,
				]
			: []
	return {
		status: reasons.length > 0 ? 'tripped' : 'clear',
		reasons,
		repairToCohortRatio,
		repairCap: config.repairCap,
		maxRepairToCohortRatio: config.maxRepairToCohortRatio,
	}
}

export async function reconcileLearnerFlow(args: {
	repository: LearnerFlowReconcilerRepository
	allowlist: GateDRuntimeAllowlist
	email7LiveEnabled: boolean
	now: string
	config?: LearnerFlowReconcilerConfig
}): Promise<LearnerFlowReconcilerReceipt> {
	const config = args.config ?? LEARNER_FLOW_RECONCILER_CONFIG
	const plan = await buildLearnerFlowReconcilerPlan(args)
	const brake = evaluateLearnerFlowReconcilerBrake({
		cohortSize: plan.cohort.contacts,
		candidates: plan.candidates,
		config,
	})
	if (brake.status === 'tripped') {
		return receiptFor({ plan, brake, config })
	}

	const selected = plan.candidates.slice(0, config.repairCap)
	const blocked = selected.filter(
		(candidate) => candidate.action === 'replan-blocked-intent',
	)
	const drip = selected.filter(
		(candidate) => candidate.action === 'nudge-drip-progression',
	)
	const repairCandidates = selected.filter(
		(candidate) =>
			candidate.action === 'repair-completion-and-nudge-drip' &&
			candidate.repairEvidence,
	)
	const repairResults = await repairValuePathCompletionFacts({
		repository: args.repository,
		evidence: repairCandidates.map((candidate) => candidate.repairEvidence!),
		allowWrite: true,
		now: args.now,
	})
	const replanResult = blocked.length
		? await replanBlockedValuePathEmailIntents({
				repository: args.repository,
				contactIds: unique(blocked.map((candidate) => candidate.contactId)),
				intentIds: blocked.map((candidate) => candidate.intentId),
				allowWrite: true,
				now: args.now,
			})
		: emptyReplanResult()
	const dripIntents = [
		...intentsById(plan.records).filter((intent) =>
			drip.some((candidate) => candidate.intentId === intent.id),
		),
		...repairResults.flatMap((result) =>
			result.updatedIntent ? [result.updatedIntent] : [],
		),
	]
	const dripResult = dripIntents.length
		? await progressValuePathDrips({
				repository: args.repository,
				allowlist: args.allowlist,
				completedIntents: dripIntents,
				allowWrite: true,
				email7LiveEnabled: args.email7LiveEnabled,
				now: args.now,
			})
		: emptyDripResult()

	return receiptFor({
		plan,
		brake,
		config,
		replanResult,
		dripResult,
		repairResults,
		selected,
	})
}

function receiptFor(args: {
	plan: LearnerFlowReconcilerPlan
	brake: LearnerFlowReconcilerBrake
	config: LearnerFlowReconcilerConfig
	replanResult?: IntentReplanResult
	dripResult?: ValuePathDripProgressionResult
	repairResults?: ValuePathCompletionRepairResult[]
	selected?: LearnerFlowReconcilerCandidate[]
}): LearnerFlowReconcilerReceipt {
	const selected = args.selected ?? []
	const dripResults = args.dripResult?.results ?? []
	const repairResults = args.repairResults ?? []
	const advancedIntentIds = new Set([
		...repairResults.map((result) => result.intentId),
		...(args.replanResult?.results ?? [])
			.filter((result) => result.status === 'replanned')
			.map((result) => result.intentId),
	])
	const advancedContactIds = new Set(
		dripResults
			.filter(
				(result) =>
					result.status === 'planned' || result.status === 'idempotent-noop',
			)
			.map((result) => result.contactId),
	)
	const advanced = selected.filter(
		(candidate) =>
			advancedIntentIds.has(candidate.intentId) ||
			advancedContactIds.has(candidate.contactId),
	)
	const writeFailedContactIds = new Set(
		dripResults
			.filter((result) => result.status === 'deferred')
			.map((result) => result.contactId),
	)
	const blockedResults = dripResults.filter(
		(result) => result.status === 'blocked',
	)
	const unserved = (
		args.brake.status === 'tripped'
			? args.plan.candidates
			: [
					...args.plan.candidates.slice(args.config.repairCap),
					...selected.filter((candidate) => !advanced.includes(candidate)),
				]
	).sort(compareCandidateAge)
	const oldestUnserved = unserved[0]
	const tier2Causes = args.plan.tier2.map((item) => item.cause)
	const writeFailed = writeFailedContactIds.size
	const blockedReasons = boundedReasonCounts(
		blockedResults.flatMap((result) => result.reviewReasons),
	)
	const failureReasons = unique([
		...args.brake.reasons,
		...(writeFailed > 0 ? ['repair-write-failed'] : []),
		...tier2Causes.map((cause) => `tier2:${cause}`),
	])
	const status =
		args.brake.status === 'tripped'
			? 'blocked'
			: writeFailed > 0 || blockedResults.length > 0 || args.plan.tier2.length > 0
				? 'degraded'
				: 'ok'

	return {
		event: 'subscriber_funnel.drip_run_completed',
		receiptVersion: 2,
		funnel: 'skills-newsletter',
		loop: 'repair',
		status,
		workSeen: args.plan.candidates.length,
		workDone: unique(advanced.map((candidate) => candidate.intentId)).length,
		oldestUnservedAt: oldestUnserved?.lastActivityAt ?? null,
		oldestUnservedAgeHours: oldestUnserved?.stuckAgeHours ?? null,
		counts: {
			completionFactsRepaired: repairResults.length,
			intentsReplanned: args.replanResult?.counts.replanned ?? 0,
			intentsCreated: args.dripResult?.counts.planned ?? 0,
			noop:
				(args.dripResult?.counts.idempotentNoop ?? 0) +
				(args.dripResult?.counts.terminal ?? 0),
			blocked: args.dripResult?.counts.blocked ?? 0,
			notDue: args.dripResult?.counts.notDue ?? 0,
			failed: args.dripResult?.counts.deferred ?? 0,
			deferred: unserved.length,
			writeFailed,
			retriesExhausted: tier2Causes.filter(
				(cause) => cause === 'provider-retries-exhausted',
			).length,
			permanentProviderFailures: tier2Causes.filter(
				(cause) => cause === 'provider-permanent-failure',
			).length,
			tier2: args.plan.tier2.length,
		},
		blockedReasons,
		failureReasons,
		causeCounts: args.plan.causeCounts,
		brake: {
			status: args.brake.status,
			reasons: args.brake.reasons,
		},
	}
}

function emptyReplanResult(): IntentReplanResult {
	return {
		mode: 'value-path-intent-replan',
		allowWrite: true,
		counts: {
			contacts: 0,
			blockedIntentsFound: 0,
			replanned: 0,
			wouldReplan: 0,
		},
		results: [],
	}
}

function emptyDripResult(): ValuePathDripProgressionResult {
	return {
		mode: 'allow-write',
		counts: {
			completedIntents: 0,
			planned: 0,
			blocked: 0,
			terminal: 0,
			idempotentNoop: 0,
			notDue: 0,
			deferred: 0,
		},
		results: [],
	}
}

function intentsById(records: LearnerFlowCohortRecord[]) {
	return records.flatMap((record) => record.intents)
}

function compareCandidateAge(
	left: LearnerFlowReconcilerCandidate,
	right: LearnerFlowReconcilerCandidate,
) {
	return (
		(left.lastActivityAt ?? '').localeCompare(right.lastActivityAt ?? '') ||
		left.contactId.localeCompare(right.contactId) ||
		left.intentId.localeCompare(right.intentId)
	)
}

function formatRatio(value: number) {
	return `${(value * 100).toFixed(1)}%`
}

function hoursSince(then: string, now: string) {
	return Math.max(0, Date.parse(now) - Date.parse(then)) / (60 * 60 * 1000)
}

function stringField(value: unknown) {
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

const MAX_RECONCILER_BLOCKED_REASONS = 10

function boundedReasonCounts(reasons: string[]) {
	const counts = new Map<string, number>()
	for (const reason of reasons) {
		counts.set(reason, (counts.get(reason) ?? 0) + 1)
	}
	return Object.fromEntries(
		[...counts.entries()]
			.sort(
				([leftReason, leftCount], [rightReason, rightCount]) =>
					rightCount - leftCount || leftReason.localeCompare(rightReason),
			)
			.slice(0, MAX_RECONCILER_BLOCKED_REASONS),
	)
}

function unique<T>(values: T[]) {
	return [...new Set(values)]
}
