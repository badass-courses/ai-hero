import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Effect } from 'effect'
import { fixtureEntry } from './bounded-readers.fixtures'
import { makeInMemoryJourneyLedger } from './in-memory-ledger'
import { createEvergreenOfferJourneyService } from './service'
import { EVERGREEN_OFFER_JOURNEY_V1 } from './definition'
import {
	createCouponIntentExecutor,
	type CouponExecutorDependencies,
} from './coupon-executor'
import { decodeAttempt, type AttemptEvidence } from './attempt-evidence'
import type { EligibilityFacts, IssuedCoupon } from './domain'
import type {
	CouponIssueReceipt,
	EffectApplicationError,
	JourneyLedger,
} from './ports'
import type { CouponReceiptInspection } from './coupon-receipt-reader'
import {
	parseIsoInstant,
	parseCouponId,
	parseStimulusId,
	parseVerifiedUserId,
} from './primitives'

export function instant(text: string) {
	const parsed = parseIsoInstant(text)
	if (!parsed.ok) throw new Error('Invalid fixture time')
	return parsed.value
}
function couponId() {
	const parsed = parseCouponId('coupon-executor-test')
	if (!parsed.ok) throw new Error('Invalid fixture coupon')
	return parsed.value
}
function stimulusId(text: string) {
	const parsed = parseStimulusId(text)
	if (!parsed.ok) throw new Error('Invalid fixture stimulus')
	return parsed.value
}

/** Synthetic, no provider or global database. Optional real ledger/attempts for guarded MySQL. */
export async function couponExecutorFixture(real?: {
	ledger: JourneyLedger
	attempts: CouponExecutorDependencies['attempts']
}) {
	const ledger = real?.ledger ?? makeInMemoryJourneyLedger()
	const entry = fixtureEntry('coupon-executor')
	await Effect.runPromise(ledger.commit(entry))
	let now = entry.decidedAt
	const state = {
		mutations: 0,
		authorityCalls: 0,
		denyAfterClaim: false,
		deny: false,
		failDomain: false,
		failRecord: false,
		slow: false,
		unknownHistory: false,
		legacyHistory: false,
		effectError: null as EffectApplicationError | null,
		receipt: null as CouponIssueReceipt | null,
		operationAt: now,
		couponStatus: 1,
		usedCount: 0,
	}
	const clock = { now: Effect.sync(() => now) }
	const authority = {
		currentFacts: (
			args: Parameters<
				CouponExecutorDependencies['authority']['currentFacts']
			>[0],
		) =>
			Effect.sync((): EligibilityFacts => {
				state.authorityCalls++
				return {
					contactId: args.contactId,
					existingJourneyId: args.journeyId,
					purchase: null,
					delivery: { type: 'Eligible' },
					automationControl:
						state.deny || (state.denyAfterClaim && state.authorityCalls > 1)
							? { type: 'Stopped', version: 'off', reason: 'test stop' }
							: { type: 'Enabled', version: 'on' },
					evidenceVersion: 'test',
					readAt: now,
				}
			}),
	}
	const service = createEvergreenOfferJourneyService({
		ledger,
		authority,
		clock,
		definition: EVERGREEN_OFFER_JOURNEY_V1,
	})
	const messageWake = entry.decision.wakeIntents.find(
		(wake) => wake.purpose.type === 'MessageSlot',
	)
	if (!messageWake) throw new Error('Missing message wake')
	now = messageWake.dueAt
	await Effect.runPromise(
		service.advance({
			type: 'WakeDue',
			stimulusId: stimulusId('message-wake'),
			journeyId: messageWake.journeyId,
			wakeId: messageWake.wakeId,
			dueAt: messageWake.dueAt,
			purpose: messageWake.purpose,
		}),
	)
	const wake = entry.decision.wakeIntents.find(
		(wake) => wake.purpose.type === 'CouponIssue',
	)
	if (!wake) throw new Error('Missing coupon wake')
	now = wake.dueAt
	await Effect.runPromise(
		service.advance({
			type: 'WakeDue',
			stimulusId: stimulusId('coupon-wake'),
			journeyId: wake.journeyId,
			wakeId: wake.wakeId,
			dueAt: wake.dueAt,
			purpose: wake.purpose,
		}),
	)
	const view = await Effect.runPromise(
		ledger.inspect({
			journeyId: wake.journeyId,
			now,
			automationControl: 'Enabled',
		}),
	)
	const issue = view.intents.find(
		(row) => row.intent.type === 'IssueCoupon',
	)?.intent
	if (!issue || issue.type !== 'IssueCoupon')
		throw new Error('Missing coupon intent')
	now = instant(new Date(Date.parse(now) + 500).toISOString())
	state.authorityCalls = 0
	const records = new Map<string, AttemptEvidence>()
	const unavailable = {
		type: 'AttemptUnavailable' as const,
		reason: 'synthetic failure',
	}
	const settle: CouponExecutorDependencies['attempts']['settle'] = (input) =>
		Effect.try({
			try: () => {
				if (state.failRecord) throw new Error('record failure')
				const existing = records.get(input.idempotencyKey)
				if (
					!existing ||
					existing.claimToken !== input.claimToken ||
					existing.journeyId !== input.journeyId
				)
					throw new Error('identity')
				if (isDeepStrictEqual(existing.outcome, input.outcome)) return existing
				if (
					existing.status !== 'Claimed' &&
					existing.status !== 'HeldUncertain'
				)
					throw new Error('settled')
				if (
					input.outcome.type === 'KnownNotApplied' &&
					(!input.outcome.observedAt ||
						new Date(input.outcome.observedAt) > input.now)
				)
					throw new Error('observation')
				const saved = decodeAttempt({
					...existing,
					status: input.outcome.type,
					outcome: input.outcome,
				})
				records.set(saved.idempotencyKey, saved)
				return saved
			},
			catch: () => unavailable,
		})
	const attempts: CouponExecutorDependencies['attempts'] = real?.attempts ?? {
		claim: (input) =>
			Effect.sync(() => {
				const previous = records.get(input.idempotencyKey)
				if (previous)
					return { type: 'AlreadyAttempted' as const, state: previous.status }
				const evidence = decodeAttempt({
					format: 'evergreen-offer-journey.attempt.v1',
					idempotencyKey: input.idempotencyKey,
					journeyId: input.journeyId,
					claimedAt: input.now,
					leaseExpiresAt: input.leaseExpiresAt,
					claimToken: randomUUID(),
					status: 'Claimed',
					outcome: null,
				})
				records.set(input.idempotencyKey, evidence)
				return { type: 'Claimed' as const, evidence }
			}),
		settle,
		reconcileAccepted: settle,
		recoveryPage: (input) =>
			Effect.sync(() => {
				const candidates = [...records.values()]
					.filter(
						(row) => row.status === 'Claimed' || row.status === 'HeldUncertain',
					)
					.map((evidence) => ({ evidence, state: 'HeldUncertain' as const }))
				return {
					candidates,
					scanned: candidates.length,
					end: true,
					nextCursor: input.after ?? null,
				}
			}),
		recordedOutcomeRecoveryPage: (input) =>
			Effect.gen(function* () {
				const current = yield* ledger.inspect({
					journeyId: issue.journeyId,
					now,
					automationControl: 'Stopped',
				})
				const candidates = [...records.values()]
					.filter(
						(row) =>
							row.status === 'Accepted' || row.status === 'KnownNotApplied',
					)
					.map((evidence) => {
						const intent = current.intents.find(
							(row) => row.intent.idempotencyKey === evidence.idempotencyKey,
						)?.intent
						if (!intent) throw new Error('Missing intent')
						return { evidence, intent }
					})
				return {
					candidates,
					scanned: candidates.length,
					end: true,
					nextCursor: input.after ? { ...input.after } : null,
				}
			}).pipe(Effect.mapError(() => unavailable)),
	}
	function recorded(): CouponReceiptInspection<CouponIssueReceipt> {
		if (!state.receipt || state.unknownHistory)
			return { type: 'Unknown', reason: 'test missing' }
		return {
			type: 'Recorded',
			historicalOnly: true,
			receipt: state.receipt,
			operationObservedAt: state.legacyHistory
				? { type: 'Unknown' }
				: { type: 'Known', at: state.operationAt },
			current: {
				couponStatus: state.couponStatus,
				usedCount: state.usedCount,
				expiresAt: state.receipt.coupon.expiresAt,
			},
		}
	}
	const dependencies: CouponExecutorDependencies = {
		ledger,
		attempts,
		authority,
		clock,
		service: {
			advance: (stimulus) =>
				state.failDomain
					? Effect.fail({
							type: 'JourneyCommitUnavailable',
							reason: 'synthetic failure',
						})
					: service.advance(stimulus),
		},
		coupons: {
			issue: (intent) =>
				Effect.suspend(() => {
					state.mutations++
					if (state.effectError) return Effect.fail(state.effectError)
					const coupon: IssuedCoupon = {
						couponId: couponId(),
						contactId: intent.contactId,
						issuedAt: intent.issueAt,
						expiresAt: intent.expiresAt,
						deadlineTimeZone: intent.deadlineTimeZone,
						terms: intent.terms,
						binding: { type: 'AwaitingVerifiedUser' },
					}
					state.operationAt = now
					state.receipt = { coupon, providerReceiptId: 'commerce-coupon:test' }
					if (state.slow)
						now = instant(new Date(Date.parse(now) + 120_000).toISOString())
					return Effect.succeed(state.receipt)
				}),
			bind: (intent) =>
				Effect.suspend(() => {
					state.mutations++
					if (state.effectError) return Effect.fail(state.effectError)
					if (!state.receipt) throw new Error('Missing issued coupon')
					state.receipt = {
						coupon: {
							...state.receipt.coupon,
							binding: {
								type: 'BoundToVerifiedUser',
								verifiedUserId: intent.verifiedUserId,
								boundAt: now,
							},
						},
						providerReceiptId: 'commerce-entitlement:test',
					}
					return Effect.succeed(state.receipt)
				}),
		},
		receipts: {
			inspectIssue: () => Effect.sync(recorded),
			inspectBinding: () => Effect.sync(recorded),
		},
	}
	const executor = createCouponIntentExecutor(dependencies)
	return {
		executor,
		dependencies,
		ledger,
		service,
		state,
		records,
		issue,
		request: {
			journeyId: issue.journeyId,
			idempotencyKey: issue.idempotencyKey,
		},
		setNow: (at: string) => {
			now = instant(at)
		},
		getNow: () => now,
		async prepareBinding() {
			const result = await Effect.runPromise(
				executor.execute({
					journeyId: issue.journeyId,
					idempotencyKey: issue.idempotencyKey,
				}),
			)
			if (result.type !== 'Committed')
				throw new Error(`Issue failed: ${result.reason}`)
			now = instant(new Date(Date.parse(now) + 1000).toISOString())
			const user = parseVerifiedUserId('coupon-user')
			if (!user.ok) throw new Error('Invalid user')
			await Effect.runPromise(
				service.advance({
					type: 'VerifiedUserObserved',
					stimulusId: stimulusId('verified-user'),
					journeyId: issue.journeyId,
					verifiedUserId: user.value,
					observedAt: now,
					sourceReference: 'synthetic-verified-proof',
				}),
			)
			const current = await Effect.runPromise(
				ledger.inspect({
					journeyId: issue.journeyId,
					now,
					automationControl: 'Stopped',
				}),
			)
			const bind = current.intents.find(
				(row) => row.intent.type === 'BindCoupon',
			)?.intent
			if (!bind || bind.type !== 'BindCoupon')
				throw new Error('Missing binding')
			return bind
		},
	}
}
