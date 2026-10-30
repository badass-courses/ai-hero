import { emailEquivalenceKey } from '@/lib/subscriber-marketing/contact-email-equivalence'

/**
 * A join held while its person is not known yet. Double opt-in means a new
 * address may confirm hours or days after it joined a waitlist, and until
 * then there is no local contact to hang a ContactEvent on and no drovr
 * contact to resolve. The pending row keeps the join, by email key and list,
 * until interest-fact-record attaches it or the confirm window closes.
 *
 * The row holds the earliest join time and nothing else: the key is the
 * hashed email key, so Redis never stores an address. The waiting Inngest
 * run carries the address itself. Inngest's idempotency on email and list
 * lasts 24 hours; a second join after that starts a second run, and the row
 * is what gives both runs the first join's time.
 */

/** Upstash's surface, structurally, so tests can pass a fake. */
export type PendingInterestStore = {
	get<T>(key: string): Promise<T | null>
	set(
		key: string,
		value: PendingInterestRow,
		options: { ex: number; nx?: true },
	): Promise<unknown>
	del(key: string): Promise<unknown>
}

export type PendingInterestRow = { at: string }

/** The confirm window plus a day, so a run at its last check still finds it. */
export const PENDING_INTEREST_TTL_SECONDS = 8 * 24 * 60 * 60

export function pendingInterestKey(email: string, fieldKey: string) {
	return `interest-fact:pending:v1:${emailEquivalenceKey(email)}:${fieldKey}`
}

async function readAt(store: PendingInterestStore, key: string) {
	const row = await store.get<PendingInterestRow>(key)
	return row && Number.isFinite(Date.parse(row.at))
		? new Date(row.at).toISOString()
		: undefined
}

/**
 * Hold a join and answer the earliest time held for this person and list.
 * The first hold wins the slot; a later hold with an earlier time (a
 * backfill carrying Kit's date) moves the row back to that time.
 */
export async function holdPendingInterestFact(
	store: PendingInterestStore,
	args: { email: string; fieldKey: string; at: string },
): Promise<{ status: 'held' | 'existing'; firstAt: string }> {
	const key = pendingInterestKey(args.email, args.fieldKey)
	const at = new Date(args.at).toISOString()
	let existing = await readAt(store, key)
	if (!existing) {
		const won = await store.set(
			key,
			{ at },
			{ nx: true, ex: PENDING_INTEREST_TTL_SECONDS },
		)
		if (won) return { status: 'held', firstAt: at }
		// A concurrent join took the slot; its time is the one to compare.
		existing = await readAt(store, key)
		if (!existing) return { status: 'held', firstAt: at }
	}
	if (existing <= at) return { status: 'existing', firstAt: existing }
	await store.set(key, { at }, { ex: PENDING_INTEREST_TTL_SECONDS })
	return { status: 'held', firstAt: at }
}

/** The join is recorded or its window closed; the row has done its job. */
export async function releasePendingInterestFact(
	store: PendingInterestStore,
	args: { email: string; fieldKey: string },
) {
	await store.del(pendingInterestKey(args.email, args.fieldKey))
}
