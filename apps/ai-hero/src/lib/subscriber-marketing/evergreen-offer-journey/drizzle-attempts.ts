import { randomUUID } from 'node:crypto'
import {
	evergreenOfferJourneyAttempt as attempts,
	evergreenOfferJourneyIntent as intents,
} from '@/db/evergreen-offer-journey-schema'
import { and, asc, eq, inArray, lte, or, sql } from 'drizzle-orm'
import { Effect } from 'effect'
import { z } from 'zod'
import {
	AcceptedOutcome,
	AttemptIdentity,
	AttemptOutcome,
	attemptStateAt,
	decodeAttempt,
	type AttemptEvidence,
} from './attempt-evidence'
import {
	readIntentForAttempt,
	type EvergreenOfferJourneyDatabase,
	type EvergreenOfferJourneyTransaction,
} from './drizzle-ledger'

export type AttemptError = {
	readonly type: 'AttemptRefused' | 'AttemptUnavailable'
	readonly reason: string
}
class AttemptRefusal extends Error {}
const time = z.date()
const claimInput = AttemptIdentity.omit({ claimToken: true })
	.extend({ now: time, leaseExpiresAt: time })
	.strict()
const settlementInput = AttemptIdentity.extend({
	now: time,
	outcome: AttemptOutcome,
}).strict()
const recoveryInput = z
	.object({ now: time, limit: z.number().int().min(1).max(100) })
	.strict()

/** Dormant persistence only. A claim is NOT reusable control/authority permission.
 * The future executor must reread both immediately before I/O and source each
 * operation's now from the shared Clock, never a cached claim-time value. No method retries,
 * reclaims, renews, calls providers, or marks a journey intent as sent.
 */
export function createDrizzleJourneyAttempts(
	database: EvergreenOfferJourneyDatabase,
) {
	function run<Value>(work: () => Promise<Value>) {
		return Effect.tryPromise({
			try: work,
			catch: (cause): AttemptError => ({
				type:
					cause instanceof AttemptRefusal || cause instanceof z.ZodError
						? 'AttemptRefused'
						: 'AttemptUnavailable',
				// Never expose database errors, provider payloads, credentials or identities.
				reason:
					cause instanceof AttemptRefusal
						? cause.message
						: 'Attempt boundary rejected or unavailable',
			}),
		})
	}
	return {
		claim(input: z.infer<typeof claimInput>) {
			return run(async () => {
				const request = claimInput.parse(input)
				if (
					request.leaseExpiresAt <= request.now ||
					request.leaseExpiresAt.getTime() - request.now.getTime() > 300_000
				)
					throw new AttemptRefusal(
						'Claim lease must be positive and at most five minutes',
					)
				return database.transaction(async (tx) => {
					// The durable intent row exists before claims. Serializes claimers even
					// when no attempt row exists; the unique PK remains a second guard.
					await tx.execute(
						sql`SELECT ${intents.idempotencyKey} FROM ${intents} WHERE ${intents.idempotencyKey} = ${request.idempotencyKey} FOR UPDATE`,
					)
					const row = await tx.query.evergreenOfferJourneyIntent.findFirst({
						where: eq(intents.idempotencyKey, request.idempotencyKey),
					})
					if (!row || row.journeyId !== request.journeyId)
						throw new AttemptRefusal('Exact intent ownership required')
					const previous =
						await tx.query.evergreenOfferJourneyAttempt.findFirst({
							where: eq(attempts.idempotencyKey, request.idempotencyKey),
						})
					if (previous) {
						const evidence = decodeAttempt(previous)
						if (evidence.journeyId !== request.journeyId)
							throw new AttemptRefusal('Attempt journey mismatch')
						return {
							type: 'AlreadyAttempted' as const,
							state: attemptStateAt(evidence, request.now),
						}
					}
					if (row.status !== 'Pending' || row.availableAt > request.now)
						throw new AttemptRefusal('Intent is not pending and due')
					// Same structural erasure as the ledger itself; concrete tx owns runtime methods.
					const intent = await readIntentForAttempt(
						tx as unknown as EvergreenOfferJourneyTransaction,
						row,
					)
					if (
						(intent.type === 'SendMessage' &&
							(request.now < new Date(intent.notBefore) ||
								request.now >= new Date(intent.notAfter))) ||
						(intent.type === 'IssueCoupon' &&
							(request.now < new Date(intent.issueAt) ||
								request.now >= new Date(intent.expiresAt)))
					)
						throw new AttemptRefusal('Effect window is closed')
					const evidence = decodeAttempt({
						format: 'evergreen-offer-journey.attempt.v1',
						idempotencyKey: request.idempotencyKey,
						journeyId: request.journeyId,
						claimToken: randomUUID(),
						status: 'Claimed',
						claimedAt: request.now,
						leaseExpiresAt: request.leaseExpiresAt,
						outcome: null,
					})
					await tx.insert(attempts).values(evidence)
					return { type: 'Claimed' as const, evidence }
				})
			})
		},
		/** Live owner only. Expired/cancelled/crashed attempts stay held. */
		settle(input: z.infer<typeof settlementInput>) {
			return run(() => settle(settlementInput.parse(input), false))
		},
		/** Records read-only provider acceptance evidence, never performs reconciliation I/O.
		 * Absence/unknown cannot clear the original attempt. Caller retains the exact token.
		 */
		reconcileAccepted(
			input: AttemptIdentity & { now: Date; outcome: AcceptedOutcome },
		) {
			return run(() =>
				settle(
					settlementInput.parse({
						...input,
						outcome: AcceptedOutcome.parse(input.outcome),
					}),
					true,
				),
			)
		},
		/** Bounded evidence query, not a scanner or an execution queue. */
		recovery(input: z.infer<typeof recoveryInput>) {
			return run(async () => {
				const request = recoveryInput.parse(input)
				const rows = await database
					.select()
					.from(attempts)
					.where(
						or(
							and(
								eq(attempts.status, 'Claimed'),
								lte(attempts.leaseExpiresAt, request.now),
							),
							eq(attempts.status, 'HeldUncertain'),
						),
					)
					.orderBy(asc(attempts.leaseExpiresAt), asc(attempts.idempotencyKey))
					.limit(request.limit)
				return rows.map((row) => ({
					evidence: decodeAttempt(row),
					state: 'HeldUncertain' as const,
				}))
			})
		},
		/** Recorded provider outcome awaiting domain settlement, NEVER reapplication.
		 * Missed SendMessage slots permit truthful late DeliverySettled correction.
		 * Other effect types retain their existing Pending-only settlement policy.
		 */
		recordedOutcomeRecovery(input: z.infer<typeof recoveryInput>) {
			return run(async () => {
				const request = recoveryInput.parse(input)
				return database.transaction(async (tx) => {
					const rows = await tx
						.select({ attempt: attempts, intentRow: intents })
						.from(attempts)
						.innerJoin(
							intents,
							eq(intents.idempotencyKey, attempts.idempotencyKey),
						)
						.where(
							and(
								inArray(attempts.status, ['Accepted', 'KnownNotApplied']),
								or(
									eq(intents.status, 'Pending'),
									and(
										eq(intents.status, 'Missed'),
										eq(intents.intentType, 'SendMessage'),
									),
								),
							),
						)
						.orderBy(
							asc(attempts.status),
							asc(attempts.leaseExpiresAt),
							asc(attempts.idempotencyKey),
						)
						.limit(request.limit)
					const recovered = []
					for (const row of rows) {
						const evidence = decodeAttempt(row.attempt)
						const intent = await readIntentForAttempt(
							tx as unknown as EvergreenOfferJourneyTransaction,
							row.intentRow,
						)
						if (
							evidence.journeyId !== intent.journeyId ||
							evidence.idempotencyKey !== intent.idempotencyKey
						)
							throw new AttemptRefusal('Recorded attempt ownership mismatch')
						recovered.push({ evidence, intent })
					}
					return recovered
				})
			})
		},
	}

	async function settle(
		request: z.infer<typeof settlementInput>,
		reconcile: boolean,
	): Promise<AttemptEvidence> {
		return database.transaction(async (tx) => {
			await tx.execute(
				sql`SELECT ${attempts.idempotencyKey} FROM ${attempts} WHERE ${attempts.idempotencyKey} = ${request.idempotencyKey} FOR UPDATE`,
			)
			const row = await tx.query.evergreenOfferJourneyAttempt.findFirst({
				where: eq(attempts.idempotencyKey, request.idempotencyKey),
			})
			if (!row) throw new AttemptRefusal('Attempt not found')
			const evidence = decodeAttempt(row)
			if (
				evidence.journeyId !== request.journeyId ||
				evidence.claimToken !== request.claimToken
			)
				throw new AttemptRefusal('Current exact attempt ownership required')
			if (request.now < evidence.claimedAt)
				throw new AttemptRefusal('Settlement predates claim')
			if (
				evidence.status === request.outcome.type &&
				JSON.stringify(evidence.outcome) === JSON.stringify(request.outcome)
			)
				return evidence
			const state = attemptStateAt(evidence, request.now)
			if (
				reconcile
					? !['Claimed', 'HeldUncertain'].includes(state)
					: state !== 'Claimed'
			)
				throw new AttemptRefusal(
					'Attempt is held or already settled; no automatic retry',
				)
			if (
				request.outcome.type === 'Accepted' &&
				(new Date(request.outcome.appliedAt) < evidence.claimedAt ||
					new Date(request.outcome.appliedAt) > request.now)
			)
				throw new AttemptRefusal('Acceptance time is outside claim evidence')
			const next = decodeAttempt({
				...evidence,
				status: request.outcome.type,
				outcome: request.outcome,
			})
			await tx
				.update(attempts)
				.set({ status: next.status, outcome: next.outcome })
				.where(
					and(
						eq(attempts.idempotencyKey, request.idempotencyKey),
						eq(attempts.journeyId, request.journeyId),
						eq(attempts.claimToken, request.claimToken),
						eq(attempts.status, evidence.status),
					),
				)
			return next
		})
	}
}
