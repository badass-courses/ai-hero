import { drovrOutboxDedupeKey, type DrovrOutboxEntry } from './drovr-outbox'
import {
	readHeldContinuationEnvelope,
	type OwnerStopRejection,
} from './drovr-outbox-control'
import { isNeverBornOwnerStopProblem } from './drovr-stop-verdict'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

/** Negative evidence only: this never means a stop was accepted by drovr. */
export interface OwnerStopRejectionRow {
	dedupeKey: string
	target: string
	endpoint: string
	tenantId: string
	contactId: string
	journeyId: string
	eventType: string
	idempotencyKey: string
	occurredAt: string
	body: unknown
	status: string
	lastStatus: number | null
	lastAttemptAt: string | null
	heldContinuation?: unknown
	/** Deliberately opaque; never read by the exclusion decision. */
	lastError?: string | null
}
export type OwnerStopRejectionIssue =
	| 'row-not-rejected'
	| 'directory-scope'
	| 'missing-receipt'
	| 'malformed-receipt'
	| 'scope-mismatch'
	| 'body-mismatch'
	| 'attempt-mismatch'
export type OwnerStopRejectionDecision =
	| { exclude: true; receipt: OwnerStopRejection }
	| { exclude: false; issue: OwnerStopRejectionIssue; message: string }

const keep = (issue: OwnerStopRejectionIssue): OwnerStopRejectionDecision => ({
	exclude: false,
	issue,
	message: `OwnerStopRejection: you checked a stop gate, and it failed because the typed refusal receipt has ${issue}. Accepted: a Schema-valid rejected owner stop with exact target, full scope, immutable body identity and rejected attempt evidence. Fix: retain this gate until its actual disposition is proved; never infer release from lastError. Debug: inspect heldContinuation.ownerStopRejection and the scoped row without exposing its body.`,
})
const canonicalInstant = (value: unknown): string | undefined => {
	if (typeof value !== 'string') return undefined
	const stamp = Date.parse(value)
	return Number.isFinite(stamp) ? new Date(stamp).toISOString() : undefined
}

/** Fail closed. Error prose is not an input to any branch, even as a fallback. */
export function decideOwnerStopRejection(
	row: OwnerStopRejectionRow,
): OwnerStopRejectionDecision {
	if (row.status !== 'rejected') return keep('row-not-rejected')
	if (row.journeyId === 'contact-directory') return keep('directory-scope')
	let receipt: OwnerStopRejection | undefined
	try {
		receipt = readHeldContinuationEnvelope(
			row.heldContinuation,
		)?.ownerStopRejection
	} catch {
		return keep('malformed-receipt')
	}
	if (!receipt) return keep('missing-receipt')
	const scope = receipt.scope
	if (
		scope.key !== row.dedupeKey ||
		scope.target !== row.target ||
		scope.endpoint !== row.endpoint ||
		scope.tenantId !== row.tenantId ||
		scope.contactId !== row.contactId ||
		scope.journeyId !== row.journeyId ||
		scope.eventType !== row.eventType ||
		scope.idempotencyKey !== row.idempotencyKey ||
		scope.occurredAt !== canonicalInstant(row.occurredAt) ||
		drovrOutboxDedupeKey(scope.target, scope) !== scope.key
	)
		return keep('scope-mismatch')
	let body: Record<string, unknown>
	try {
		const value = typeof row.body === 'string' ? JSON.parse(row.body) : row.body
		if (!value || typeof value !== 'object' || Array.isArray(value))
			return keep('body-mismatch')
		body = value as Record<string, unknown>
	} catch {
		return keep('body-mismatch')
	}
	if (
		body.tenantId !== scope.tenantId ||
		body.contactId !== scope.contactId ||
		body.journeyId !== scope.journeyId ||
		body.idempotencyKey !== scope.idempotencyKey ||
		body.type !== scope.eventType ||
		canonicalInstant(body.occurredAt) !== scope.occurredAt
	)
		return keep('body-mismatch')
	if (
		row.lastStatus !== receipt.httpStatus ||
		canonicalInstant(row.lastAttemptAt) !== receipt.decidedAt
	)
		return keep('attempt-mismatch')
	return { exclude: true, receipt }
}

export interface OwnerStopRejectionInput {
	target: string
	entry: DrovrOutboxEntry
	problem: unknown
	httpStatus: number
	rejectedAttempt: OwnerStopRejection['rejectedAttempt']
	decidedAt: string
}

/** Called only with an actual POST's coded answer, not with error prose. */
export function buildOwnerStopRejection(
	input: OwnerStopRejectionInput,
): OwnerStopRejection {
	const { entry } = input
	const fail = (why: string): never => {
		throw new Error(
			`OwnerStopRejection: you retained an owner refusal, and it failed because ${why}. Accepted: an actual coded never-born answer for this exact immutable owner-stop scope and rejected POST attempt. Fix: preserve the gate and inspect the scoped response; never substitute error text or mark rejection delivered. Debug: inspect the SDK attempt and heldContinuation without exposing the body.`,
		)
	}
	const body = entry.body as DrovrShadowEvent
	if (
		entry.endpoint !== 'events' ||
		!body ||
		typeof body.idempotencyKey !== 'string' ||
		!isNeverBornOwnerStopProblem(body, input.problem)
	)
		return fail(
			'the POST answer is not a coded never-born owner-stop rejection',
		)
	const occurredAt = canonicalInstant(entry.occurredAt)
	if (!occurredAt) return fail('the original event clock is invalid')
	const scope = {
		key: drovrOutboxDedupeKey(input.target, entry),
		target: input.target,
		endpoint: entry.endpoint,
		tenantId: entry.tenantId,
		contactId: entry.contactId,
		journeyId: entry.journeyId,
		eventType: entry.eventType,
		idempotencyKey: entry.idempotencyKey,
		occurredAt,
	}
	const receipt = readHeldContinuationEnvelope({
		v: 1,
		ownerStopRejection: {
			v: 1,
			scope,
			rejectionCode: 'cold-start-never-born',
			httpStatus: input.httpStatus,
			rejectedAttempt: input.rejectedAttempt,
			decidedAt: input.decidedAt,
		},
	})!.ownerStopRejection!
	const decision = decideOwnerStopRejection({
		...entry,
		dedupeKey: scope.key,
		target: input.target,
		status: 'rejected',
		lastStatus: input.httpStatus,
		lastAttemptAt: input.decidedAt,
		heldContinuation: { v: 1, ownerStopRejection: receipt },
	})
	if (!decision.exclude) return fail(decision.issue)
	return receipt
}
