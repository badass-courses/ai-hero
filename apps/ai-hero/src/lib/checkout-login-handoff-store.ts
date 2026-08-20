import { randomUUID } from 'node:crypto'
import { db } from '@/db'
import { checkoutLoginHandoff } from '@/db/schema'
import type { CheckoutLoginHandoffPayload } from '@/lib/checkout-login-handoff'
import {
	checkoutLoginHandoffSourcesFor,
	type CheckoutLoginHandoffState,
} from '@/lib/checkout-login-handoff-lifecycle'
import { and, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm'

export type CheckoutLoginHandoffClaim = {
	nonceHash: string
	claimId: string
	userId: string
}

export type CheckoutLoginHandoffClaimResult =
	| { kind: 'acquired'; claim: CheckoutLoginHandoffClaim }
	| { kind: 'completed'; redirect: string }
	| { kind: 'replayed'; state: CheckoutLoginHandoffState }
	| {
			kind:
				| 'missing'
				| 'expired'
				| 'browser-mismatch'
				| 'user-mismatch'
				| 'scope-mismatch'
	  }

export type CheckoutLoginHandoffStore = {
	issue(input: {
		nonceHash: string
		browserSessionHash: string
		payload: CheckoutLoginHandoffPayload
		boundUserId?: string
		now?: Date
	}): Promise<void>
	claim(input: {
		nonceHash: string
		browserSessionHash: string
		payload: CheckoutLoginHandoffPayload
		userId: string
		now?: Date
	}): Promise<CheckoutLoginHandoffClaimResult>
	complete(input: {
		claim: CheckoutLoginHandoffClaim
		redirect: string
		now?: Date
	}): Promise<boolean>
	failRetryable(input: {
		claim: CheckoutLoginHandoffClaim
		now?: Date
	}): Promise<boolean>
}

function rowsAffected(result: unknown) {
	if (!result || typeof result !== 'object') return 0
	const value = result as {
		rowsAffected?: unknown
		affectedRows?: unknown
		rowCount?: unknown
	}
	return Number(
		value.rowsAffected ?? value.affectedRows ?? value.rowCount ?? 0,
	)
}

function rowMatchesPayload(
	row: typeof checkoutLoginHandoff.$inferSelect,
	payload: CheckoutLoginHandoffPayload,
) {
	return (
		row.country === payload.country &&
		row.productId === payload.productId &&
		row.quantity === payload.quantity &&
		row.pppSelected === payload.pppSelected &&
		row.issuedAt.getTime() === payload.issuedAt &&
		row.expiresAt.getTime() === payload.expiresAt
	)
}

export const checkoutLoginHandoffStore: CheckoutLoginHandoffStore = {
	async issue({
		nonceHash,
		browserSessionHash,
		payload,
		boundUserId,
		now = new Date(),
	}) {
		await db.transaction(async (transaction) => {
			await transaction
				.delete(checkoutLoginHandoff)
				.where(lte(checkoutLoginHandoff.expiresAt, now))
			await transaction.insert(checkoutLoginHandoff).values({
				nonceHash,
				browserSessionHash,
				country: payload.country,
				productId: payload.productId,
				quantity: payload.quantity,
				pppSelected: payload.pppSelected,
				state: 'issued',
				boundUserId: boundUserId ?? null,
				claimId: null,
				checkoutRedirect: null,
				issuedAt: new Date(payload.issuedAt),
				expiresAt: new Date(payload.expiresAt),
				completedAt: null,
				updatedAt: now,
			})
		})
	},

	async claim({
		nonceHash,
		browserSessionHash,
		payload,
		userId,
		now = new Date(),
	}) {
		const claimId = randomUUID()
		const result = await db
			.update(checkoutLoginHandoff)
			.set({
				state: 'consuming',
				boundUserId: userId,
				claimId,
				updatedAt: now,
			})
			.where(
				and(
					eq(checkoutLoginHandoff.nonceHash, nonceHash),
					eq(checkoutLoginHandoff.browserSessionHash, browserSessionHash),
					eq(checkoutLoginHandoff.country, payload.country),
					eq(checkoutLoginHandoff.productId, payload.productId),
					eq(checkoutLoginHandoff.quantity, payload.quantity),
					eq(checkoutLoginHandoff.pppSelected, payload.pppSelected),
					eq(checkoutLoginHandoff.issuedAt, new Date(payload.issuedAt)),
					eq(checkoutLoginHandoff.expiresAt, new Date(payload.expiresAt)),
				gt(checkoutLoginHandoff.expiresAt, now),
				inArray(
					checkoutLoginHandoff.state,
					checkoutLoginHandoffSourcesFor('consuming'),
				),
				or(
					isNull(checkoutLoginHandoff.boundUserId),
					eq(checkoutLoginHandoff.boundUserId, userId),
				),
			),
		)

		if (rowsAffected(result) === 1) {
			return {
				kind: 'acquired',
				claim: { nonceHash, claimId, userId },
			}
		}

		const row = await db.query.checkoutLoginHandoff.findFirst({
			where: eq(checkoutLoginHandoff.nonceHash, nonceHash),
		})
		if (!row) return { kind: 'missing' }
		if (row.expiresAt <= now) return { kind: 'expired' }
		if (row.browserSessionHash !== browserSessionHash) {
			return { kind: 'browser-mismatch' }
		}
		if (!rowMatchesPayload(row, payload)) return { kind: 'scope-mismatch' }
		if (row.boundUserId && row.boundUserId !== userId) {
			return { kind: 'user-mismatch' }
		}
		if (row.state === 'completed' && row.checkoutRedirect) {
			return { kind: 'completed', redirect: row.checkoutRedirect }
		}
		return {
			kind: 'replayed',
			state: row.state as CheckoutLoginHandoffState,
		}
	},

	async complete({ claim, redirect, now = new Date() }) {
		const result = await db
			.update(checkoutLoginHandoff)
			.set({
				state: 'completed',
				checkoutRedirect: redirect,
				completedAt: now,
				claimId: null,
				updatedAt: now,
			})
			.where(
				and(
					eq(checkoutLoginHandoff.nonceHash, claim.nonceHash),
					inArray(
						checkoutLoginHandoff.state,
						checkoutLoginHandoffSourcesFor('completed'),
					),
					eq(checkoutLoginHandoff.claimId, claim.claimId),
					eq(checkoutLoginHandoff.boundUserId, claim.userId),
				),
			)
		return rowsAffected(result) === 1
	},

	async failRetryable({ claim, now = new Date() }) {
		const result = await db
			.update(checkoutLoginHandoff)
			.set({
				state: 'failed_retryable',
				claimId: null,
				updatedAt: now,
			})
			.where(
				and(
					eq(checkoutLoginHandoff.nonceHash, claim.nonceHash),
					inArray(
						checkoutLoginHandoff.state,
						checkoutLoginHandoffSourcesFor('failed_retryable'),
					),
					eq(checkoutLoginHandoff.claimId, claim.claimId),
					eq(checkoutLoginHandoff.boundUserId, claim.userId),
				),
			)
		return rowsAffected(result) === 1
	},
}
