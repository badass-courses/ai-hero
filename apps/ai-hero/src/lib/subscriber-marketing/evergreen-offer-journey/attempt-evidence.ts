import { z } from 'zod'

const exactId = z
	.string()
	.min(1)
	.max(500)
	.refine((value) => value.trim() === value && !value.includes('*'))
export const AttemptIdentity = z
	.object({
		idempotencyKey: exactId,
		journeyId: exactId,
		claimToken: z.string().uuid(),
	})
	.strict()
export type AttemptIdentity = z.infer<typeof AttemptIdentity>

export const AcceptedOutcome = z
	.object({
		type: z.literal('Accepted'),
		providerReceiptId: exactId,
		appliedAt: z.string().datetime({ precision: 3 }),
	})
	.strict()
export type AcceptedOutcome = z.infer<typeof AcceptedOutcome>
export const AttemptOutcome = z.discriminatedUnion('type', [
	AcceptedOutcome,
	z
		.object({
			type: z.literal('HeldUncertain'),
			reason: z.enum(['Timeout', 'Cancelled', 'Unknown']),
		})
		.strict(),
	z
		.object({
			type: z.literal('KnownNotApplied'),
			reason: z.enum(['PreflightRefused', 'ProviderRefused']),
		})
		.strict(),
])
export type AttemptOutcome = z.infer<typeof AttemptOutcome>

const Attempt = AttemptIdentity.extend({
	format: z.literal('evergreen-offer-journey.attempt.v1'),
	claimedAt: z.date(),
	leaseExpiresAt: z.date(),
	status: z.enum(['Claimed', 'Accepted', 'HeldUncertain', 'KnownNotApplied']),
	outcome: AttemptOutcome.nullable(),
})
	.strict()
	.superRefine((row, ctx) => {
		if (
			row.leaseExpiresAt <= row.claimedAt ||
			(row.status === 'Claimed'
				? row.outcome !== null
				: row.outcome?.type !== row.status) ||
			(row.outcome?.type === 'Accepted' &&
				new Date(row.outcome.appliedAt) < row.claimedAt)
		) {
			ctx.addIssue({ code: 'custom', message: 'Inconsistent attempt evidence' })
		}
	})
export type AttemptEvidence = z.infer<typeof Attempt>

/** Persistence boundary. Never return arbitrary row statuses as domain truth. */
export function decodeAttempt(input: unknown): AttemptEvidence {
	return Attempt.parse(input)
}
export function attemptStateAt(
	attempt: AttemptEvidence,
	now: Date,
): AttemptEvidence['status'] {
	return attempt.status === 'Claimed' && now >= attempt.leaseExpiresAt
		? 'HeldUncertain'
		: attempt.status
}
