/**
 * A per-contact counter, bumped once per profile sync. drovr keeps the
 * highest profileVersion it has seen, so two syncs must never share a
 * version: the second one's idempotency key would dedupe to nothing.
 */
export type ContactProfileVersionStore = {
	bump(contactId: string): Promise<number>
}

export function createMemoryContactProfileVersionStore(): ContactProfileVersionStore {
	const versions = new Map<string, number>()
	return {
		async bump(contactId) {
			const next = (versions.get(contactId) ?? 0) + 1
			versions.set(contactId, next)
			return next
		},
	}
}
