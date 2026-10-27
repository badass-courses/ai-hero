import { createHash } from 'node:crypto'

import {
	DROVR_AUTHORITY_TENANT_ID,
	deliverDrovrShadowEvent,
	mapDrovrShadowFact,
	type DrovrDeliveryOutcome,
	type DrovrShadowEvent,
} from './drovr-shadow-emitter'
import {
	buildPurchaseRecordedEvent,
	type PurchaseRecordedSource,
} from './lifecycle-contact-events'
import type { ContactEventRecord } from './types'

/**
 * A buyer with no ai-hero Contact can still be a drovr contact, matched there
 * by Kit email. drovr's `resolve_contacts` maps emails to drovr contact ids so
 * the purchase fact can reach the right contact. ai-hero never creates a
 * Contact for the buyer, and never sends a shadow-newsletter birth.
 */

export const RESOLVE_CONTACTS_MAX_EMAILS = 1000

export type DrovrContactResolution =
	| { status: 'resolved'; contactId: string }
	| { status: 'missing' }
	| { status: 'conflict' }

export class DrovrResolveUnavailableError extends Error {
	constructor(reason: string) {
		super(`drovr resolve_contacts unavailable: ${reason}`)
		this.name = 'DrovrResolveUnavailableError'
	}
}

export const normalizeResolveEmail = (email: string) =>
	email.trim().toLowerCase()

/** Log-safe stand-in for an email. Never log the address itself. */
export const emailLogHash = (email: string) =>
	createHash('sha256')
		.update(normalizeResolveEmail(email), 'utf8')
		.digest('hex')
		.slice(0, 12)

/**
 * Resolve emails against drovr, read-only. Emails are normalized
 * (trimmed, lowercased) and de-duplicated in first-seen order; answers map by
 * each result's index within its batch's items and are keyed by that email. Any transport fault, non-200,
 * malformed body or missing answer throws DrovrResolveUnavailableError so the
 * caller's step retries; a conflict is an answer, never a throw.
 */
export async function resolveDrovrContacts(args: {
	emails: readonly string[]
	config: { baseUrl: string; apiKey: string }
	fetcher?: typeof fetch
	timeoutMs?: number
}): Promise<Map<string, DrovrContactResolution>> {
	const emails = Array.from(new Set(args.emails.map(normalizeResolveEmail)))
	const answers = new Map<string, DrovrContactResolution>()
	for (
		let start = 0;
		start < emails.length;
		start += RESOLVE_CONTACTS_MAX_EMAILS
	) {
		const batch = emails.slice(start, start + RESOLVE_CONTACTS_MAX_EMAILS)
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 10_000)
		let body: unknown
		try {
			const response = await (args.fetcher ?? fetch)(
				`${args.config.baseUrl.replace(/\/+$/, '')}/resolve_contacts`,
				{
					method: 'POST',
					headers: {
						accept: 'application/json',
						authorization: `Bearer ${args.config.apiKey}`,
						'content-type': 'application/json',
					},
					body: JSON.stringify({ items: batch.map((email) => ({ email })) }),
					signal: controller.signal,
				},
			)
			if (response.status !== 200) {
				throw new DrovrResolveUnavailableError(`status ${response.status}`)
			}
			body = await response.json()
		} catch (error) {
			if (error instanceof DrovrResolveUnavailableError) throw error
			throw new DrovrResolveUnavailableError(
				error instanceof Error ? error.name : 'transport',
			)
		} finally {
			clearTimeout(timer)
		}
		const results = readResults(body)
		// One entry per item, by index within this batch's items.
		batch.forEach((email, position) => {
			const item = results.find((candidate) => candidate.index === position)
			if (item?.status === 'resolved' && typeof item.contactId === 'string') {
				answers.set(email, { status: 'resolved', contactId: item.contactId })
			} else if (item?.status === 'missing' || item?.status === 'conflict') {
				answers.set(email, { status: item.status })
			} else {
				// No entry for an index is unknown, not missing: retry.
				throw new DrovrResolveUnavailableError('incomplete answer')
			}
		})
	}
	return answers
}

function readResults(body: unknown): Array<Record<string, unknown>> {
	const list =
		body && typeof body === 'object'
			? (body as Record<string, unknown>).results
			: undefined
	if (!Array.isArray(list)) {
		throw new DrovrResolveUnavailableError('malformed answer')
	}
	return list.filter(
		(item): item is Record<string, unknown> =>
			Boolean(item) && typeof item === 'object',
	)
}

/**
 * The purchase.recorded events for a buyer drovr already knows, under the
 * same idempotency key the ContactEvent mirror uses
 * (`aihero:ai-hero:purchase.recorded:purchase:<purchaseId>`). The
 * shadow-newsletter birth the mirror also maps is dropped: this buyer has no
 * ai-hero contact to birth, and drovr's contact already exists.
 */
export function drovrPurchaseRecordedEventsFor(
	source: PurchaseRecordedSource,
	drovrContactId: string,
): DrovrShadowEvent[] {
	const normalized = buildPurchaseRecordedEvent(source, {
		source: 'ai-hero',
		strength: 'strong',
	})
	const record: ContactEventRecord = {
		...normalized,
		id: `drovr-resolved:${source.purchaseId}`,
		contactId: drovrContactId,
		providerIdentityId: '',
		createdAt: source.purchasedAt,
	}
	return mapDrovrShadowFact({ kind: 'contact-event', event: record }).filter(
		(event) => event.type === 'purchase.recorded',
	)
}

/**
 * Post the events the retired-shadow rules still deliver (authority tenant
 * only). A transient failure throws so the Inngest step retries; a final 4xx
 * is returned for the caller to log.
 */
export async function deliverResolvedPurchaseEvents(args: {
	events: readonly DrovrShadowEvent[]
	config: { ingestUrl: string; apiKey: string }
	fetcher?: typeof fetch
	timeoutMs?: number
	now?: number
}): Promise<{
	accepted: number
	rejected: number
	/** Rejections by `<HTTP status> <problem type>`; no ids. */
	rejections: Record<string, number>
}> {
	let accepted = 0
	let rejected = 0
	const rejections: Record<string, number> = {}
	const outcomes: DrovrDeliveryOutcome[] = []
	for (const event of args.events.filter(
		(candidate) => candidate.tenantId === DROVR_AUTHORITY_TENANT_ID,
	)) {
		outcomes.push(
			await deliverDrovrShadowEvent({
				event,
				config: args.config,
				fetcher: args.fetcher,
				timeoutMs: args.timeoutMs,
				clampAt: args.now ?? Date.now(),
			}),
		)
	}
	for (const outcome of outcomes) {
		if (outcome.status === 'accepted') accepted += 1
		else if (outcome.status === 'rejected') {
			rejected += 1
			const key = `${outcome.httpStatus} ${problemTypeOf(outcome.problem)}`
			rejections[key] = (rejections[key] ?? 0) + 1
		} else throw new Error(`drovr purchase delivery failed: ${outcome.reason}`)
	}
	return { accepted, rejected, rejections }
}

/** The problem's `type` only, bounded; never the detail, which may name ids. */
function problemTypeOf(problem: unknown): string {
	const type =
		problem && typeof problem === 'object'
			? (problem as Record<string, unknown>).type
			: undefined
	return typeof type === 'string' && type ? type.slice(0, 120) : 'unknown'
}
