import { createHash } from 'node:crypto'
import {
	readHeldContinuationEnvelope,
	type UnsubscribeSupersession,
} from './drovr-outbox-control'

export const unsubscribeSupersessionDiagnostic = (at: string) =>
	`UnsubscribeSuperseded: you resumed a historical unsubscribe, and it failed because contact.resubscribed at ${at} is strictly newer at whole-second precision. Accepted: local closure only, never a late HTTP POST or a delivery acknowledgement. Fix: retain the typed source proof and immutable wire body. Debug: inspect heldContinuation.unsubscribeSupersession and ContactEvent evidence (3mxwwjnmt7iq6).`

export interface UnsubscribeProofRow {
	dedupeKey: string
	target: string
	endpoint: string
	tenantId: string
	contactId: string
	journeyId: string
	eventType: string
	idempotencyKey: string
	occurredAt: string | Date
	body: unknown
	heldContinuation?: unknown
	/** Operator prose only; never used to prove supersession. */
	lastError?: string | null
}
export type UnsubscribeSupersessionDecision =
	| { proved: true; proof: UnsubscribeSupersession }
	| {
			proved: false
			issue:
				| 'missing-proof'
				| 'malformed-proof'
				| 'scope-mismatch'
				| 'body-mismatch'
	  }

export function supersessionInstant(value: unknown): string | undefined {
	if (value instanceof Date)
		return Number.isFinite(value.getTime()) ? value.toISOString() : undefined
	if (typeof value !== 'string') return undefined
	const stamp = Date.parse(
		/(Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value.replace(' ', 'T')}Z`,
	)
	return Number.isFinite(stamp) ? new Date(stamp).toISOString() : undefined
}
/** Frozen v1 identity: identical to drovrOutboxDedupeKey's six-tuple. Kept
 * dependency-free to avoid an outbox -> closure -> outbox runtime cycle. */
function keyOf(row: UnsubscribeProofRow): string {
	return createHash('sha256')
		.update(
			JSON.stringify([
				row.target,
				row.endpoint,
				row.tenantId,
				row.contactId,
				row.journeyId,
				row.idempotencyKey,
			]),
		)
		.digest('hex')
}
export function readUnsubscribeSupersession(
	row: UnsubscribeProofRow,
): UnsubscribeSupersessionDecision {
	let proof: UnsubscribeSupersession | undefined
	try {
		proof = readHeldContinuationEnvelope(
			row.heldContinuation,
		)?.unsubscribeSupersession
	} catch {
		return { proved: false, issue: 'malformed-proof' }
	}
	if (!proof) return { proved: false, issue: 'missing-proof' }
	const scope = proof.scope
	if (
		row.dedupeKey !== scope.key ||
		keyOf(row) !== scope.key ||
		row.target !== scope.target ||
		row.endpoint !== scope.endpoint ||
		row.tenantId !== scope.tenantId ||
		row.contactId !== scope.contactId ||
		row.journeyId !== scope.journeyId ||
		row.eventType !== scope.eventType ||
		row.idempotencyKey !== scope.idempotencyKey ||
		supersessionInstant(row.occurredAt) !== scope.occurredAt
	)
		return { proved: false, issue: 'scope-mismatch' }
	try {
		const body = typeof row.body === 'string' ? JSON.parse(row.body) : row.body
		if (
			!body ||
			typeof body !== 'object' ||
			Array.isArray(body) ||
			body.tenantId !== scope.tenantId ||
			body.contactId !== scope.contactId ||
			body.journeyId !== scope.journeyId ||
			body.idempotencyKey !== scope.idempotencyKey ||
			body.type !== scope.eventType ||
			supersessionInstant(body.occurredAt) !== scope.occurredAt
		)
			return { proved: false, issue: 'body-mismatch' }
	} catch {
		return { proved: false, issue: 'body-mismatch' }
	}
	return { proved: true, proof }
}
export function supersededUnsubscribeAt(
	row: UnsubscribeProofRow,
): string | undefined {
	const decision = readUnsubscribeSupersession(row)
	return decision.proved ? decision.proof.source.occurredAt : undefined
}
export function buildUnsubscribeSupersession(
	row: UnsubscribeProofRow,
	resubscribedAt: string,
	decidedAt: string,
): UnsubscribeSupersession {
	const occurredAt = supersessionInstant(row.occurredAt)
	const lift = supersessionInstant(resubscribedAt)
	const proof = readHeldContinuationEnvelope({
		v: 1,
		unsubscribeSupersession: {
			v: 1,
			scope: {
				key: row.dedupeKey,
				target: row.target,
				endpoint: row.endpoint,
				tenantId: row.tenantId,
				contactId: row.contactId,
				journeyId: row.journeyId,
				eventType: row.eventType,
				idempotencyKey: row.idempotencyKey,
				occurredAt,
			},
			source: {
				table: 'AI_ContactEvent',
				eventType: 'contact.resubscribed',
				contactId: row.contactId,
				occurredAt: lift,
			},
			decidedAt,
		},
	})!.unsubscribeSupersession!
	const decision = readUnsubscribeSupersession({
		...row,
		heldContinuation: { v: 1, unsubscribeSupersession: proof },
	})
	if (!decision.proved)
		throw new Error(
			`UnsubscribeClosure: you retained a resubscribe proof, and it failed because the first-owned unsubscribe has ${decision.issue}. Accepted: full immutable scope and a source-cited strictly newer whole-second contact.resubscribed. Fix: preserve the gate and inspect the scoped evidence; never parse lastError or rebase a body. Debug: inspect the retained row and ContactEvent source without exposing bodies.`,
		)
	return proof
}
