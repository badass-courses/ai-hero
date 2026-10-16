import { profileVersionBump } from './contact-sync-deltas'
import type { ProfileAckReference } from './contact-sync-profile-ack-schema'
import { profileAckFlagEnabled } from './contact-sync-profile-ack-flag'
import { completeMemoryProfileAck, type MemoryProfileAckCompletion } from './contact-profile-version-memory-ack'

export type LegacyProfileAcknowledgement = (contactId: string, profileVersion: number, request?: ProfileAckReference['request']) => Promise<boolean>

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
	/** A matching legacy digest was rewritten without spending a version. */
	migrated?: boolean
	acknowledgedAt?: string
	/** New-code SDK provenance only, never the enable flag or receiver proof. */
	profileAckProtocol?: 1
	/** Set only by the effect that actually created/bumped this version. */
	newlyIssued?: true
}

export type ContactProfileVersionStore = {
	currentFor(contactId: string): Promise<(ContactProfileVersion & { contentHash: string }) | undefined>
	versionFor(
		contactId: string,
		contentHash: string,
		legacyHash?: string,
	): Promise<ContactProfileVersion>
	/**
	 * Records that drovr fully accepted `profileVersion`. A no-op when the
	 * contact has moved on to a newer version since.
	 */
	acknowledge(contactId: string, profileVersion: number, request?: ProfileAckReference['request']): Promise<void>
	/** Reports whether the never-registered OFF writer actually ran. */
	acknowledgeLegacy?: LegacyProfileAcknowledgement
}

export function createMemoryContactProfileVersionStore(
	options: { now?: () => string; includeRegistrationCapability?: boolean; profileAckEnabled?: () => Promise<boolean>; hasRegisteredProfileAck?: (contactId: string, profileVersion: number, request?: ProfileAckReference['request']) => Promise<boolean> | boolean; beforeProfileAckCommit?: () => void } = {},
): ContactProfileVersionStore & { acknowledgeLegacy: LegacyProfileAcknowledgement; acknowledgeFrozen: MemoryProfileAckCompletion } {
	const now = options.now ?? (() => new Date().toISOString())
	const capability = (newlyIssued = false, acknowledgedAt?: string) => options.includeRegistrationCapability ? { profileAckProtocol: 1 as const, ...(newlyIssued ? { newlyIssued: true as const } : {}), ...(acknowledgedAt ? { acknowledgedAt } : {}) } : {}
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
	const acknowledgeLegacy: LegacyProfileAcknowledgement = async (contactId, profileVersion, request) => {
		if (await profileAckFlagEnabled({ readFlag: options.profileAckEnabled ?? (async () => false) })) return false
		if (await options.hasRegisteredProfileAck?.(contactId, profileVersion, request)) return false
		const current = rows.get(contactId)
		if (!current || current.profileVersion !== profileVersion) return false
		if (current.acknowledgedVersion === profileVersion && request?.kind !== 'restate') return false
		if (request?.kind === 'restate' && current.acknowledgedAt && current.acknowledgedAt.slice(0, 7) >= request.period) return false
		current.acknowledgedVersion = profileVersion
		current.acknowledgedAt = now()
		return true
	}
	return {
		acknowledgeLegacy,
		acknowledgeFrozen: input => completeMemoryProfileAck({ ...input, enabled: options.profileAckEnabled ?? (async () => false), authority: () => rows.get(input.ref.contactId), beforeCommit: options.beforeProfileAckCommit }),
		async currentFor(contactId) {
			const row = rows.get(contactId)
			return row ? { profileVersion: row.profileVersion, since: row.since, contentHash: row.contentHash, acknowledgedAt: row.acknowledgedAt, acknowledged: row.acknowledgedVersion === row.profileVersion, ...capability(false, row.acknowledgedAt) } : undefined
		},
		async versionFor(contactId, contentHash, legacyHash) {
			const current = rows.get(contactId)
			if (current && !current.contentHash.startsWith('v2:') && current.contentHash === legacyHash) {
				current.contentHash = contentHash
				return { profileVersion: current.profileVersion, since: current.since, acknowledged: current.acknowledgedVersion === current.profileVersion, migrated: true, ...capability(false, current.acknowledgedAt) }
			}
			if (current && !profileVersionBump({ kind: 'profile-change', previousHash: current.contentHash, nextHash: contentHash })) {
				return {
					profileVersion: current.profileVersion,
					since: current.since,
					acknowledged: current.acknowledgedVersion === current.profileVersion,
					...capability(false, current.acknowledgedAt),
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
				...capability(true),
			}
		},
		async acknowledge(contactId, profileVersion, request) {
			await acknowledgeLegacy(contactId, profileVersion, request)
		},
	}
}
