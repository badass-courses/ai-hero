import type { EmailListConfig } from '@coursebuilder/core/providers'

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
import type { SideEffectIntent } from './types'
import {
	executePendingValuePathEmailIntents,
	type ValuePathEmailExecutionResult,
	type ValuePathEmailExecutorConfig,
	type ValuePathEmailExecutorRepository,
} from './value-path-email-executor'
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
} from './value-path-completed-at-backfill'
import { valuePathIntentCompletedAt } from './value-path-completion'

/**
 * Maintained-after safety config. The send cap bounds one run's blast radius:
 * overflow is served oldest-first up to the cap and the rest DEFERS to the
 * next run (reported, never dropped) — exceeding the cap is normal on a big
 * signup day, not an anomaly. The brake is the anomaly detector: the 25%
 * plan-to-cohort ratio wall sits above the observed 22.8% backlog-drain peak,
 * while the 313 false-stuck incident would hit 37.7% and trip it. The first
 * live brake trip (2026-07-18: 172 planned / 1,006 learners = 17.1%, a
 * healthy big day) proved cap-exceeds must not brake — it stalled 172 real
 * learners for an hour. Change these values only with reconciler receipts
 * beside the change.
 */
export type LearnerFlowReconcilerConfig = {
	sendCap: number
	maxPlannedToCohortRatio: number
}

export const LEARNER_FLOW_RECONCILER_CONFIG: LearnerFlowReconcilerConfig = {
	sendCap: 150,
	maxPlannedToCohortRatio: 0.25,
}

export const LEARNER_FLOW_RECONCILER_CHECK_COMMAND =
	'pnpm --filter ai-hero subscriber-marketing:operator learner-flow-stuck-list --json'

export type LearnerFlowReconcilerCandidate = {
	contactId: string
	intentId: string
	action:
		| 'replan-blocked-intent'
		| 'retry-transient-failure'
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
	plannedToCohortRatio: number
	cap: number
	maxPlannedToCohortRatio: number
}

export type LearnerFlowReconcilerRepository = LearnerFlowCohortRepository &
	ValuePathDripProgressionRepository &
	ValuePathEmailExecutorRepository &
	IntentReplanRepository &
	Pick<ValuePathCompletedAtBackfillRepository, 'updateSideEffectIntent'>

export type LearnerFlowReconcilerReceipt = {
	event: 'subscriber_funnel.drip_run_completed'
	receiptVersion: 1
	funnel: 'skills-newsletter'
	loop: 'reconciler'
	generatedAt: string
	plannerSource: 'learner-flow-classifier'
	brake: 'clear' | 'tripped'
	brakeReasons: string[]
	cap: number
	maxPlannedToCohortRatio: number
	plannedToCohortRatio: number
	cohortSize: number
	workSeen: number
	workDone: number
	oldestUnservedAgeHours: number | null
	oldestUnservedAt: string | null
	created: number
	repairedCompletionFacts: number
	replanned: number
	retried: number
	served: number
	deferred: number
	oldestDeferredAgeHours: number | null
	oldestDeferredAt: string | null
	tier2: number
	causeCounts: Partial<Record<LearnerFlowStuckCause, number>>
	completedIntents: number
	planned: number
	terminal: number
	noop: number
	parked: number
	blocked: number
	idempotentNoop: number
	notDue: number
	starved: number
	suppressedFixtureStarved: number
	suppressionExpiresAt: string | null
	zeroPlanWhileStarved: boolean
	scanTruncated: boolean
	scanned: number
	eligible: number
	frontierSize: number
	actionableFrontierSize: number
	returned: number
	truncated: number
	excludedMissingCompletedAt: number
	excludedByScope: number
	excludedTerminal: number
	excludedExistingNextIntent: number
	oldestFrontierCompletedAt?: string
	oldestFrontierAgeHours?: number
	executor: {
		processed: number
		completed: number
		blocked: number
		failed: number
		retryableFailed: number
		skipped: number
	}
	dmPriority: 'high' | null
	dmLine: string
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
				stuckAgeHours: hoursSince(
					repairEvidence.completedAt,
					args.now,
				),
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
			stuck: classified.filter((item) => item.classification.state === 'stuck')
				.length,
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
	planned: number
	cohortSize: number
	candidates?: LearnerFlowReconcilerCandidate[]
	config?: LearnerFlowReconcilerConfig
}): LearnerFlowReconcilerBrake {
	const config = args.config ?? LEARNER_FLOW_RECONCILER_CONFIG
	const plannedToCohortRatio =
		args.cohortSize > 0 ? args.planned / args.cohortSize : 0
	// Cap overflow is NOT a brake reason: the cap slice serves oldest-first and
	// defers the remainder to the next run. A pure drip-starved backlog has one
	// known-safe action and is bounded by that cap. Keep the ratio wall for plans
	// containing repairs, retries, or replans, where a classifier bug can create
	// a dangerous write shape.
	const ratioWallApplies =
		!args.candidates ||
		args.candidates.some(
			(candidate) => candidate.action !== 'nudge-drip-progression',
		)
	const reasons =
		ratioWallApplies &&
		args.cohortSize > 0 &&
		plannedToCohortRatio > config.maxPlannedToCohortRatio
			? [
					`planned-ratio-${formatRatio(plannedToCohortRatio)}-exceeds-${formatRatio(config.maxPlannedToCohortRatio)}`,
				]
			: []
	return {
		status: reasons.length > 0 ? 'tripped' : 'clear',
		reasons,
		plannedToCohortRatio,
		cap: config.sendCap,
		maxPlannedToCohortRatio: config.maxPlannedToCohortRatio,
	}
}

export async function reconcileLearnerFlow(args: {
	repository: LearnerFlowReconcilerRepository
	allowlist: GateDRuntimeAllowlist
	emailListProvider: Pick<EmailListConfig, 'subscribeToList'>
	executorConfig: ValuePathEmailExecutorConfig
	now: string
	config?: LearnerFlowReconcilerConfig
}): Promise<LearnerFlowReconcilerReceipt> {
	const config = args.config ?? LEARNER_FLOW_RECONCILER_CONFIG
	const plan = await buildLearnerFlowReconcilerPlan(args)
	const brake = evaluateLearnerFlowReconcilerBrake({
		planned: plan.counts.planned,
		cohortSize: plan.cohort.contacts,
		candidates: plan.candidates,
		config,
	})
	if (brake.status === 'tripped') {
		return receiptFor({ plan, brake, config })
	}

	// The brake guarantees this slice cannot discard work. It remains here as
	// defense in depth if a future caller injects a looser brake policy.
	const selected = plan.candidates.slice(0, config.sendCap)
	const blocked = selected.filter(
		(candidate) => candidate.action === 'replan-blocked-intent',
	)
	const retryIntentIds = selected
		.filter((candidate) => candidate.action === 'retry-transient-failure')
		.map((candidate) => candidate.intentId)
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
		evidence: repairCandidates.map(
			(candidate) => candidate.repairEvidence!,
		),
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
				email7LiveEnabled: args.executorConfig.email7LiveEnabled,
				now: args.now,
			})
		: emptyDripResult()
	const createdIntentIds = dripResult.results.flatMap((result) =>
		result.status === 'planned' && result.sideEffectIntentId
			? [result.sideEffectIntentId]
			: [],
	)
	const executorIntentIds = unique([
		...retryIntentIds,
		...replanResult.results.map((result) => result.intentId),
		...createdIntentIds,
	])
	const executorResults = executorIntentIds.length
		? await executePendingValuePathEmailIntents({
				repository: args.repository,
				emailListProvider: args.emailListProvider,
				now: args.now,
				config: {
					...args.executorConfig,
					allowWrite: true,
					intentIds: executorIntentIds,
					limit: executorIntentIds.length,
				},
			})
		: []
	return receiptFor({
		plan,
		brake,
		config,
		replanResult,
		dripResult,
		executorResults,
		selected,
		repairedCompletionFacts: repairResults.length,
	})
}

function receiptFor(args: {
	plan: LearnerFlowReconcilerPlan
	brake: LearnerFlowReconcilerBrake
	config: LearnerFlowReconcilerConfig
	replanResult?: IntentReplanResult
	dripResult?: ValuePathDripProgressionResult
	executorResults?: ValuePathEmailExecutionResult[]
	selected?: LearnerFlowReconcilerCandidate[]
	repairedCompletionFacts?: number
}): LearnerFlowReconcilerReceipt {
	const executorResults = args.executorResults ?? []
	const completedIntentIds = new Set(
		executorResults.flatMap((result) =>
			result.status === 'completed' ? [result.intentId] : [],
		),
	)
	const intentIdByContact = new Map<string, string>()
	for (const candidate of args.selected ?? []) {
		if (candidate.action !== 'nudge-drip-progression') {
			intentIdByContact.set(candidate.contactId, candidate.intentId)
		}
	}
	for (const result of args.dripResult?.results ?? []) {
		if (result.sideEffectIntentId) {
			intentIdByContact.set(result.contactId, result.sideEffectIntentId)
		}
	}
	const deferred =
		args.brake.status === 'tripped'
			? args.plan.candidates
			: args.plan.candidates.slice(args.config.sendCap)
	const suppressedAsCandidates = args.plan.suppressedFixtureStarved
		.map((suppression) => {
			const intent = intentsById(args.plan.records).find(
				(candidate) => candidate.id === suppression.intentId,
			)
			const lastActivityAt = valuePathIntentCompletedAt(intent)
			return {
				contactId: suppression.contactId,
				intentId: suppression.intentId,
				action: 'nudge-drip-progression' as const,
				cause: 'drip-starved' as const,
				stage: stringField(intent?.metadata.emailResourceId) ?? 'unknown',
				lastActivityAt,
				stuckAgeHours: lastActivityAt
					? hoursSince(lastActivityAt, args.plan.generatedAt)
					: undefined,
			}
		})
		.sort(compareCandidateAge)
	const unserved = [
		...(args.brake.status === 'tripped'
			? args.plan.candidates
			: (args.selected ?? []).filter((candidate) => {
					const intentId = intentIdByContact.get(candidate.contactId)
					return !intentId || !completedIntentIds.has(intentId)
				})),
		...suppressedAsCandidates,
	].sort(compareCandidateAge)
	const oldestDeferred = deferred[0]
	const oldestUnserved = unserved[0]
	const dripResult = args.dripResult ?? emptyDripResult()
	const created = dripResult.counts.planned
	const served = executorResults.filter(
		(result) => result.status === 'completed',
	).length
	const executorCounts = {
		processed: executorResults.length,
		completed: served,
		blocked: executorResults.filter((result) => result.status === 'blocked')
			.length,
		failed: executorResults.filter((result) => result.status === 'failed')
			.length,
		retryableFailed: executorResults.filter(
			(result) => result.status === 'retryable-failed',
		).length,
		skipped: executorResults.filter((result) => result.status === 'skipped')
			.length,
	}
	const dripCandidates = args.plan.candidates.filter(
		(candidate) =>
			candidate.action === 'nudge-drip-progression' ||
			candidate.action === 'repair-completion-and-nudge-drip',
	)
	const allStarved = [...dripCandidates, ...suppressedAsCandidates]
	const allIntents = args.plan.records.flatMap((record) => record.intents)
	const terminal = args.plan.counts.terminal
	const tier2Causes = formatTier2Causes(args.plan.tier2)
	const dmLine =
		args.brake.status === 'tripped'
			? `RECONCILER BRAKED: ${args.plan.counts.planned} planned for ${args.plan.cohort.contacts} learners (${formatRatio(args.brake.plannedToCohortRatio)}; cap ${args.brake.cap}, ratio wall ${formatRatio(args.brake.maxPlannedToCohortRatio)}). Tier 2: ${tier2Causes}. Check: ${LEARNER_FLOW_RECONCILER_CHECK_COMMAND}. Action: inspect classifier causes and keep writes paused until the plan is explained.`
			: `Reconciler clear: ${created} created, ${served} served, ${deferred.length} deferred, ${suppressedAsCandidates.length} fixture-suppressed. Tier 2: ${tier2Causes}.`
	return {
		event: 'subscriber_funnel.drip_run_completed',
		receiptVersion: 1,
		funnel: 'skills-newsletter',
		loop: 'reconciler',
		generatedAt: args.plan.generatedAt,
		plannerSource: 'learner-flow-classifier',
		brake: args.brake.status,
		brakeReasons: args.brake.reasons,
		cap: args.brake.cap,
		maxPlannedToCohortRatio: args.brake.maxPlannedToCohortRatio,
		plannedToCohortRatio: args.brake.plannedToCohortRatio,
		cohortSize: args.plan.cohort.contacts,
		workSeen: args.plan.candidates.length + suppressedAsCandidates.length,
		workDone: served,
		oldestUnservedAgeHours: oldestUnserved?.stuckAgeHours ?? null,
		oldestUnservedAt: oldestUnserved?.lastActivityAt ?? null,
		created,
		repairedCompletionFacts: args.repairedCompletionFacts ?? 0,
		replanned: args.replanResult?.counts.replanned ?? 0,
		retried: (args.selected ?? []).filter(
			(candidate) => candidate.action === 'retry-transient-failure',
		).length,
		served,
		deferred: deferred.length,
		oldestDeferredAgeHours: oldestDeferred?.stuckAgeHours ?? null,
		oldestDeferredAt: oldestDeferred?.lastActivityAt ?? null,
		tier2: args.plan.tier2.length,
		causeCounts: args.plan.causeCounts,
		completedIntents: allStarved.length,
		planned: created,
		terminal,
		noop: dripResult.counts.idempotentNoop + dripResult.counts.notDue,
		parked: args.plan.tier2.length,
		blocked: dripResult.counts.blocked + executorCounts.blocked,
		idempotentNoop: dripResult.counts.idempotentNoop,
		notDue: dripResult.counts.notDue,
		starved: allStarved.length,
		suppressedFixtureStarved: suppressedAsCandidates.length,
		suppressionExpiresAt:
			args.plan.suppressedFixtureStarved
				.map((item) => item.suppressedUntil)
				.sort()[0] ?? null,
		zeroPlanWhileStarved: allStarved.length > 0 && created === 0,
		scanTruncated: false,
		scanned: allIntents.length,
		eligible: args.plan.counts.planned,
		frontierSize: allStarved.length,
		actionableFrontierSize: allStarved.length,
		returned: allStarved.length,
		truncated: 0,
		excludedMissingCompletedAt: 0,
		excludedByScope: 0,
		excludedTerminal: terminal,
		excludedExistingNextIntent: args.plan.counts.moving,
		oldestFrontierCompletedAt: allStarved
			.sort(compareCandidateAge)[0]?.lastActivityAt,
		oldestFrontierAgeHours: allStarved.sort(compareCandidateAge)[0]
			?.stuckAgeHours,
		executor: executorCounts,
		dmPriority: args.brake.status === 'tripped' ? 'high' : null,
		dmLine,
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

function formatTier2Causes(tier2: LearnerFlowReconcilerTier2Ask[]) {
	const counts = tier2.reduce<Partial<Record<LearnerFlowStuckCause, number>>>(
		(result, item) => {
			result[item.cause] = (result[item.cause] ?? 0) + 1
			return result
		},
		{},
	)
	const summary = Object.entries(counts)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([cause, count]) => `${cause}=${count}`)
		.join(', ')
	return summary || 'none'
}

function hoursSince(then: string, now: string) {
	return Math.max(0, Date.parse(now) - Date.parse(then)) / (60 * 60 * 1000)
}

function stringField(value: unknown) {
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

function unique(values: string[]) {
	return Array.from(new Set(values))
}
