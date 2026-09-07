import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Effect } from 'effect'
import { z } from 'zod'
import {
	decodeAttempt,
	refusalObservation,
	type AttemptEvidence,
	type ObservedKnownNotAppliedOutcome,
} from './attempt-evidence'
import type { createDrizzleJourneyAttempts } from './drizzle-attempts'
import type { createCouponReceiptReader } from './coupon-receipt-reader'
import type {
	EvergreenOfferStimulus,
	SideEffectIntent,
	JourneyView,
} from './domain'
import type {
	CouponAuthority,
	CouponIssueReceipt,
	EvergreenOfferJourneyService,
	JourneyClock,
	JourneyLedger,
	OfferAuthority,
} from './ports'
import {
	parseIsoInstant,
	parseJourneyId,
	parseIntentKey,
	parseStimulusId,
} from './primitives'

type CouponIntent = Extract<
	SideEffectIntent,
	{ type: 'IssueCoupon' | 'BindCoupon' }
>
type Attempts = ReturnType<typeof createDrizzleJourneyAttempts>
export type CouponExecutorDependencies = {
	ledger: Pick<JourneyLedger, 'inspect' | 'findCommittedStimulus'>
	attempts: Pick<
		Attempts,
		| 'claim'
		| 'settle'
		| 'reconcileAccepted'
		| 'recoveryPage'
		| 'recordedOutcomeRecoveryPage'
	>
	authority: OfferAuthority
	clock: JourneyClock
	service: Pick<EvergreenOfferJourneyService, 'advance'>
	coupons: CouponAuthority
	receipts: ReturnType<typeof createCouponReceiptReader>
}
export type CouponExecutionResult = {
	type: 'Committed' | 'AlreadyCommitted' | 'Held' | 'Failed'
	reason: string
	/** Whether the commerce method was invoked, not proof of a commerce commit. */
	mutation: 'NotAttempted' | 'Attempted'
}
const requestSchema = z
	.object({ journeyId: z.string().min(1), idempotencyKey: z.string().min(1) })
	.strict()
class Hold extends Error {}
const same = isDeepStrictEqual

/** Dormant sequential lifecycle: load -> preflight -> claim -> recheck -> mutate once
 * -> read history -> record -> settle domain. Recovery starts at read history.
 * No scheduler, claim takeover, retries, authentication or global provider construction.
 */
export function createCouponIntentExecutor(input: CouponExecutorDependencies) {
	const d = { ...input }
	async function clock() {
		const value = await Effect.runPromise(d.clock.now)
		const parsed = parseIsoInstant(value)
		if (!parsed.ok || parsed.value !== value)
			throw new Hold('Clock evidence invalid')
		return parsed.value
	}
	function id(key: string, kind: string) {
		const parsed = parseStimulusId(
			`coupon-executor:${createHash('sha256').update(`${key}:${kind}`).digest('hex')}`,
		)
		if (!parsed.ok) throw new Hold('Invalid settlement identity')
		return parsed.value
	}
	async function canonical(request: {
		journeyId: string
		idempotencyKey: string
	}) {
		requestSchema.parse(request)
		const journey = parseJourneyId(request.journeyId)
		const key = parseIntentKey(request.idempotencyKey)
		if (!journey.ok || !key.ok) throw new Hold('Invalid intent identity')
		const now = await clock()
		const view = await Effect.runPromise(
			d.ledger.inspect({
				journeyId: journey.value,
				now,
				automationControl: 'Stopped',
			}),
		)
		const row = view.intents.find(
			(row) => row.intent.idempotencyKey === key.value,
		)
		if (
			!row ||
			view.aggregate.journeyId !== journey.value ||
			row.intent.journeyId !== journey.value ||
			row.intent.contactId !== view.aggregate.contactId
		)
			throw new Hold('Canonical identity mismatch')
		if (row.intent.type !== 'IssueCoupon' && row.intent.type !== 'BindCoupon')
			throw new Hold('Unsupported intent')
		return { intent: structuredClone(row.intent), view, status: row.status }
	}
	async function preflight(
		intent: CouponIntent,
		view: JourneyView,
		status: string,
	) {
		const started = await clock()
		const facts = await Effect.runPromise(
			d.authority.currentFacts({
				journeyId: intent.journeyId,
				contactId: intent.contactId,
			}),
		)
		const now = await clock()
		if (
			now < started ||
			facts.readAt < started ||
			facts.readAt > now ||
			facts.contactId !== intent.contactId ||
			facts.existingJourneyId !== intent.journeyId
		)
			throw new Hold('Current authority inconsistent')
		if (facts.automationControl.type !== 'Enabled')
			throw new Hold('Control stopped')
		if (facts.purchase) {
			await domain({
				type: 'PurchaseObserved',
				stimulusId: id(
					intent.idempotencyKey,
					`purchase:${facts.purchase.purchaseId}`,
				),
				journeyId: intent.journeyId,
				purchase: facts.purchase,
			})
			throw new Hold('Purchase observed; no coupon mutation')
		}
		if (facts.delivery.type !== 'Eligible') {
			const common = {
				stimulusId: id(
					intent.idempotencyKey,
					`eligibility:${facts.delivery.type}:${facts.readAt}`,
				),
				journeyId: intent.journeyId,
				observedAt: facts.readAt,
				sourceReference: facts.delivery.evidence,
			}
			await domain(
				facts.delivery.type === 'Unsubscribed'
					? { ...common, type: 'UnsubscribeObserved' }
					: {
							...common,
							type: 'SuppressionObserved',
							reason: facts.delivery.type,
						},
			)
			throw new Hold('Ineligibility observed; no coupon mutation')
		}
		if (status !== 'pending') throw new Hold('Intent is not pending')
		const aggregate = view.aggregate
		if (intent.type === 'IssueCoupon') {
			if (
				aggregate.phase !== 'coupon.awaitingReceipt' ||
				intent.idempotencyKey !== `${intent.journeyId}:coupon.issue` ||
				now < intent.issueAt ||
				now >= intent.expiresAt
			)
				throw new Hold('Issue phase or window closed')
		} else {
			const coupon = aggregate.coupon
			if (
				aggregate.phase !== 'pitch.running' ||
				!coupon ||
				coupon.couponId !== intent.couponId ||
				coupon.contactId !== intent.contactId ||
				coupon.binding.type !== 'BindingIntentCommitted' ||
				coupon.binding.verifiedUserId !== intent.verifiedUserId ||
				coupon.binding.intentKey !== intent.idempotencyKey ||
				intent.idempotencyKey !==
					`${intent.journeyId}:coupon.bind:${intent.verifiedUserId}` ||
				now < coupon.issuedAt ||
				now >= coupon.expiresAt
			)
				throw new Hold('Binding phase or identity closed')
		}
		return now
	}
	async function history(
		intent: CouponIntent,
		evidence: AttemptEvidence,
		returned?: CouponIssueReceipt,
	) {
		const result =
			intent.type === 'IssueCoupon'
				? await Effect.runPromise(d.receipts.inspectIssue(intent))
				: await Effect.runPromise(d.receipts.inspectBinding(intent))
		if (result.type !== 'Recorded' || !result.historicalOnly)
			throw new Hold('Coupon history unknown')
		const receipt = result.receipt
		if (returned && !same(returned, receipt))
			throw new Hold('Mutation receipt differs from history')
		if (
			receipt.coupon.contactId !== intent.contactId ||
			!receipt.providerReceiptId
		)
			throw new Hold('Receipt identity mismatch')
		let at: string
		if (intent.type === 'IssueCoupon') {
			if (
				result.operationObservedAt.type !== 'Known' ||
				receipt.coupon.binding.type !== 'AwaitingVerifiedUser' ||
				receipt.coupon.issuedAt !== intent.issueAt ||
				receipt.coupon.expiresAt !== intent.expiresAt ||
				!same(receipt.coupon.terms, intent.terms) ||
				!same(receipt.coupon.deadlineTimeZone, intent.deadlineTimeZone)
			)
				throw new Hold('Original issue evidence missing')
			at = result.operationObservedAt.at
		} else {
			if (
				receipt.coupon.couponId !== intent.couponId ||
				receipt.coupon.binding.type !== 'BoundToVerifiedUser' ||
				receipt.coupon.binding.verifiedUserId !== intent.verifiedUserId
			)
				throw new Hold('Original binding evidence missing')
			at = receipt.coupon.binding.boundAt
		}
		const parsed = parseIsoInstant(at)
		const now = await clock()
		if (
			!parsed.ok ||
			parsed.value !== at ||
			new Date(at) < evidence.claimedAt ||
			at > now
		)
			throw new Hold('Operation observation outside claim evidence')
		return { receipt, at: parsed.value, now }
	}
	async function domain(stimulus: EvergreenOfferStimulus) {
		const replay = await Effect.runPromise(
			d.ledger.findCommittedStimulus(stimulus.stimulusId, stimulus),
		)
		if (replay?.committed)
			return {
				type: 'AlreadyCommitted' as const,
				reason: 'Exact stimulus already committed',
			}
		const result = await Effect.runPromise(d.service.advance(stimulus))
		if (!result.committed || result.decision.type !== 'Accepted')
			return {
				type: 'Held' as const,
				reason: 'Domain did not commit settlement',
			}
		return {
			type: result.replayedStimulus
				? ('AlreadyCommitted' as const)
				: ('Committed' as const),
			reason: 'Domain settlement committed',
		}
	}
	async function settleRecorded(
		intent: CouponIntent,
		evidence: AttemptEvidence,
	) {
		if (
			evidence.idempotencyKey !== intent.idempotencyKey ||
			evidence.journeyId !== intent.journeyId
		)
			throw new Hold('Attempt identity mismatch')
		if (evidence.outcome?.type === 'KnownNotApplied') {
			const observation = refusalObservation(evidence.outcome)
			if (observation.type !== 'Known')
				throw new Hold('Legacy refusal observation unknown')
			const parsed = parseIsoInstant(observation.observedAt)
			if (!parsed.ok) throw new Hold('Invalid refusal observation')
			return domain({
				type: 'PermanentEffectRefusal',
				scope: 'Contact',
				stimulusId: id(intent.idempotencyKey, 'refused'),
				journeyId: intent.journeyId,
				intentKey: intent.idempotencyKey,
				observedAt: parsed.value,
				reason: evidence.outcome.reason,
			})
		}
		const found = await history(intent, evidence)
		if (
			evidence.outcome?.type !== 'Accepted' ||
			evidence.outcome.appliedAt !== found.at ||
			evidence.outcome.providerReceiptId !== found.receipt.providerReceiptId
		)
			throw new Hold('Saved acceptance differs from history')
		const stimulus: EvergreenOfferStimulus =
			intent.type === 'IssueCoupon'
				? {
						type: 'CouponIssued',
						stimulusId: id(intent.idempotencyKey, 'issued'),
						journeyId: intent.journeyId,
						intentKey: intent.idempotencyKey,
						coupon: found.receipt.coupon,
					}
				: {
						type: 'CouponBoundToUser',
						stimulusId: id(intent.idempotencyKey, 'bound'),
						journeyId: intent.journeyId,
						intentKey: intent.idempotencyKey,
						couponId: intent.couponId,
						verifiedUserId: intent.verifiedUserId,
						boundAt: found.at,
					}
		return domain(stimulus)
	}
	async function accept(
		intent: CouponIntent,
		evidence: AttemptEvidence,
		returned?: CouponIssueReceipt,
	) {
		const found = await history(intent, evidence, returned)
		const record =
			evidence.status === 'Claimed' &&
			new Date(found.now) < evidence.leaseExpiresAt
				? d.attempts.settle
				: d.attempts.reconcileAccepted
		const saved = await Effect.runPromise(
			record({
				idempotencyKey: evidence.idempotencyKey,
				journeyId: evidence.journeyId,
				claimToken: evidence.claimToken,
				now: new Date(found.now),
				outcome: {
					type: 'Accepted',
					providerReceiptId: found.receipt.providerReceiptId,
					appliedAt: found.at,
				},
			}),
		)
		return settleRecorded(intent, decodeAttempt(saved))
	}
	async function safe(
		work: (state: {
			mutation: CouponExecutionResult['mutation']
		}) => Promise<Omit<CouponExecutionResult, 'mutation'>>,
	): Promise<CouponExecutionResult> {
		const state: { mutation: CouponExecutionResult['mutation'] } = {
			mutation: 'NotAttempted',
		}
		try {
			return { ...(await work(state)), mutation: state.mutation }
		} catch (error) {
			return {
				type:
					error instanceof Hold || state.mutation === 'NotAttempted'
						? 'Held'
						: 'Failed',
				reason:
					error instanceof Hold
						? error.message
						: 'Coupon execution boundary unavailable',
				mutation: state.mutation,
			}
		}
	}
	function execute(request: { journeyId: string; idempotencyKey: string }) {
		return Effect.promise(() =>
			safe(async (state) => {
				request = requestSchema.parse(request)
				const first = await canonical(request)
				const now = await preflight(first.intent, first.view, first.status)
				const claim = await Effect.runPromise(
					d.attempts.claim({
						...request,
						now: new Date(now),
						leaseExpiresAt: new Date(Date.parse(now) + 60_000),
					}),
				)
				if (claim.type !== 'Claimed')
					throw new Hold('Already attempted; read-only recovery required')
				const evidence = decodeAttempt(claim.evidence)
				if (
					evidence.journeyId !== request.journeyId ||
					evidence.idempotencyKey !== request.idempotencyKey ||
					evidence.status !== 'Claimed'
				)
					throw new Hold('Claim identity mismatch')
				const current = await canonical(request)
				if (!same(first.intent, current.intent))
					throw new Hold('Canonical intent changed')
				const at = await preflight(current.intent, current.view, current.status)
				if (
					new Date(at) < evidence.claimedAt ||
					new Date(at) >= evidence.leaseExpiresAt
				)
					throw new Hold('Claim lease unavailable')
				state.mutation = 'Attempted'
				const applied =
					current.intent.type === 'IssueCoupon'
						? await Effect.runPromise(
								Effect.either(d.coupons.issue(current.intent)),
							)
						: await Effect.runPromise(
								Effect.either(d.coupons.bind(current.intent)),
							)
				if (applied._tag === 'Right')
					return accept(current.intent, evidence, applied.right)
				if (applied.left.type !== 'EffectPermanentRefusal')
					throw new Hold('Effect outcome uncertain; no retry')
				const observedAt = await clock()
				const outcome: ObservedKnownNotAppliedOutcome = {
					type: 'KnownNotApplied',
					reason: 'ProviderRefused',
					observedAt,
				}
				const saved = await Effect.runPromise(
					d.attempts.settle({
						idempotencyKey: evidence.idempotencyKey,
						journeyId: evidence.journeyId,
						claimToken: evidence.claimToken,
						now: new Date(await clock()),
						outcome,
					}),
				)
				return settleRecorded(current.intent, decodeAttempt(saved))
			}),
		)
	}
	function recoverRecordedPage(
		request: Parameters<Attempts['recordedOutcomeRecoveryPage']>[0],
	) {
		return Effect.gen(function* () {
			const page = yield* d.attempts.recordedOutcomeRecoveryPage(request)
			const results = []
			for (const row of page.candidates)
				results.push(
					yield* Effect.promise(() =>
						safe(async () => {
							const current = await canonical({
								journeyId: row.evidence.journeyId,
								idempotencyKey: row.evidence.idempotencyKey,
							})
							if (!same(current.intent, row.intent))
								throw new Hold('Recovery canonical mismatch')
							return settleRecorded(current.intent, decodeAttempt(row.evidence))
						}),
					),
				)
			return { ...page, results }
		})
	}
	function recoverUncertainPage(
		request: Parameters<Attempts['recoveryPage']>[0],
	) {
		return Effect.gen(function* () {
			const page = yield* d.attempts.recoveryPage(request)
			const results = []
			for (const row of page.candidates)
				results.push(
					yield* Effect.promise(() =>
						safe(async () => {
							const evidence = decodeAttempt(row.evidence)
							if (
								evidence.status !== 'Claimed' &&
								evidence.status !== 'HeldUncertain'
							)
								throw new Hold('Recovery state mismatch')
							const current = await canonical({
								journeyId: evidence.journeyId,
								idempotencyKey: evidence.idempotencyKey,
							})
							return accept(current.intent, evidence)
						}),
					),
				)
			return { ...page, results }
		})
	}
	return { execute, recoverRecordedPage, recoverUncertainPage }
}
