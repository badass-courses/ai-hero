import { createHash } from 'node:crypto'

import type { ValuePathAnswerPageResource } from './value-path-answer-page'

/**
 * The answer-URL token's expiry, anchored at its first issue.
 *
 * The token used to expire at the send's dueAt + 30 days, so a contact's
 * email got a different URL every time it was personalized for a new send.
 * drovr now keeps a synced contact profile (contact sync, 2026-09-26) and
 * stores these links: a URL must stay the same until one of its inputs
 * changes, and a retry's body must stay byte-identical for PostShiba.
 *
 * So each (contact, value path, email, input fingerprint) remembers when
 * its token was first issued, and the token expires 120 days after that.
 * A changed input (Kit subscriber id, answer pages, base URL, signing
 * secret) is a new fingerprint, so a new first issue and a new URL.
 */

export const VALUE_PATH_LINK_LIFETIME_DAYS = 120

export type ValuePathLinkAnchorKey = {
	contactId: string
	valuePathSlug: string
	emailResourceId: string
	fingerprint: string
}

export type ValuePathLinkAnchor = {
	issuedAt: string
	expiresAt: string
}

export type ValuePathLinkAnchorStore = {
	find(key: ValuePathLinkAnchorKey): Promise<ValuePathLinkAnchor | undefined>
	/** Insert-or-nothing: 'exists' when another issue already holds the key. */
	insert(
		key: ValuePathLinkAnchorKey,
		anchor: ValuePathLinkAnchor,
	): Promise<'inserted' | 'exists'>
}

/**
 * A digest of every input that shapes the answer URLs: the Kit subscriber
 * id (in the token), the base URL and a digest of the signing secret, and
 * each page's slug, position and option value. Order-independent. Never
 * contains the secret.
 */
export function valuePathLinkFingerprint(args: {
	kitSubscriberId?: string
	baseUrl?: string
	secret?: string
	answerPages: readonly ValuePathAnswerPageResource[]
}): string {
	const pages = [...args.answerPages]
		.map((page) => ({
			id: page.id,
			slug: page.fields.slug,
			position: page.fields.position ?? null,
			optionValue: page.fields.optionValue ?? null,
		}))
		.sort((left, right) => left.id.localeCompare(right.id))
	const secretDigest = createHash('sha256')
		.update(args.secret ?? '')
		.digest('hex')
	return createHash('sha256')
		.update(
			JSON.stringify({
				kitSubscriberId: args.kitSubscriberId ?? null,
				baseUrl: args.baseUrl ?? null,
				secretDigest,
				pages,
			}),
		)
		.digest('hex')
}

/**
 * The anchor for this key: the stored first issue, or a new one at `now`.
 * Concurrent first issues converge on the row that won. Undefined when the
 * store is unavailable, so the caller keeps its previous expiry rather than
 * failing a send over a link's lifetime.
 */
export async function resolveValuePathLinkAnchor(args: {
	store: ValuePathLinkAnchorStore
	key: ValuePathLinkAnchorKey
	now: string
	warn?: (event: string, fields: Record<string, unknown>) => unknown
}): Promise<ValuePathLinkAnchor | undefined> {
	try {
		const found = await args.store.find(args.key)
		if (found) return found
		const anchor = {
			issuedAt: new Date(args.now).toISOString(),
			expiresAt: addDays(args.now, VALUE_PATH_LINK_LIFETIME_DAYS),
		}
		const inserted = await args.store.insert(args.key, anchor)
		if (inserted === 'inserted') return anchor
		return await args.store.find(args.key)
	} catch (error) {
		try {
			await args.warn?.('value_path.link_anchor.unavailable', {
				valuePathSlug: args.key.valuePathSlug,
				emailResourceId: args.key.emailResourceId,
				error: error instanceof Error ? error.message : String(error),
			})
		} catch {
			// Logging cannot make the anchor available.
		}
		return undefined
	}
}

export function createMemoryValuePathLinkAnchorStore(): ValuePathLinkAnchorStore {
	const rows = new Map<string, ValuePathLinkAnchor>()
	const id = (key: ValuePathLinkAnchorKey) =>
		[
			key.contactId,
			key.valuePathSlug,
			key.emailResourceId,
			key.fingerprint,
		].join('\u0000')
	return {
		async find(key) {
			return rows.get(id(key))
		},
		async insert(key, anchor) {
			if (rows.has(id(key))) return 'exists'
			rows.set(id(key), anchor)
			return 'inserted'
		},
	}
}

function addDays(iso: string, days: number): string {
	const date = new Date(iso)
	date.setUTCDate(date.getUTCDate() + days)
	return date.toISOString()
}
