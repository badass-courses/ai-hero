/**
 * A per-contact profile version, addressed by content. A sync hashes what
 * it would push; the version moves only when that hash differs from the
 * last one pushed, and `since` is when it moved. Acknowledged content is
 * skipped except for periodic profile-only re-statements with a fresh
 * timestamp and key. Two different contents never share a version: the
 * second one's key would dedupe away.
 */
export type ContactProfileVersion = {
	profileVersion: number
	/** When this version was set; original pushes and retries carry it. */
	since: string
	/** drovr fully accepted this exact version (acknowledge). */
	acknowledged: boolean
	/** Last full acceptance, used to throttle profile re-statements. */
	acknowledgedAt: string | null
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
			acknowledgedAt?: string
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
					acknowledgedAt: current.acknowledgedAt ?? null,
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
				acknowledgedAt: null,
			}
		},
		async acknowledge(contactId, profileVersion) {
			const current = rows.get(contactId)
			if (current?.profileVersion === profileVersion) {
				current.acknowledgedVersion = profileVersion
				current.acknowledgedAt = now()
			}
		},
	}
}
