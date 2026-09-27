/**
 * A per-contact profile version, addressed by content. A sync hashes what
 * it would push; the version moves only when that hash differs from the
 * last one pushed, and `since` is when it moved. An unchanged contact is
 * re-sent under the same version, keys and body, which drovr dedupes for
 * free, so the reconcile's overlap costs drovr nothing. Two different
 * contents never share a version: the second one's key would dedupe away.
 */
export type ContactProfileVersion = {
	profileVersion: number
	/** When this version was set; every event of the version carries it. */
	since: string
	/** drovr fully accepted this exact version (acknowledge). */
	acknowledged: boolean
}

export type ContactProfileVersionStore = {
	versionFor(
		contactId: string,
		contentHash: string,
	): Promise<ContactProfileVersion>
	/**
	 * Records that drovr fully accepted `profileVersion`. A no-op when the
	 * contact has moved on to a newer version since.
	 */
	acknowledge(contactId: string, profileVersion: number): Promise<void>
}

export function createMemoryContactProfileVersionStore(
	options: { now?: () => string } = {},
): ContactProfileVersionStore {
	const now = options.now ?? (() => new Date().toISOString())
	const rows = new Map<
		string,
		{
			profileVersion: number
			since: string
			contentHash: string
			acknowledgedVersion?: number
		}
	>()
	return {
		async versionFor(contactId, contentHash) {
			const current = rows.get(contactId)
			if (current?.contentHash === contentHash) {
				return {
					profileVersion: current.profileVersion,
					since: current.since,
					acknowledged: current.acknowledgedVersion === current.profileVersion,
				}
			}
			const next = {
				profileVersion: (current?.profileVersion ?? 0) + 1,
				since: now(),
				contentHash,
			}
			rows.set(contactId, next)
			return {
				profileVersion: next.profileVersion,
				since: next.since,
				acknowledged: false,
			}
		},
		async acknowledge(contactId, profileVersion) {
			const current = rows.get(contactId)
			if (current?.profileVersion === profileVersion)
				current.acknowledgedVersion = profileVersion
		},
	}
}
