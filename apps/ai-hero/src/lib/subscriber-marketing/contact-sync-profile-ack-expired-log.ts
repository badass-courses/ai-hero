import { createHash } from 'node:crypto'
import type { AckEvidenceExpired } from './contact-sync-profile-ack-schema'

export const ACK_EXPIRED_PROCESS_LRU_CAPACITY = 4096
export const ACK_EXPIRED_LOG_SIGNAL = 'drovr.profile_ack.evidence_expired'
export type AckExpiredLogger = {
	warn: (signal: string, fields: Record<string, unknown>) => unknown
}

/** Logging suppression ONLY, never ACK/capture/retry authority. At most one
 * attempt per hashed contact/version while retained in this bounded process
 * LRU. Other processes and keys evicted under pressure can log again.
 */
export function createAckExpiredProcessLogger(
	capacity = ACK_EXPIRED_PROCESS_LRU_CAPACITY,
) {
	if (
		!Number.isSafeInteger(capacity) ||
		capacity < 1 ||
		capacity > ACK_EXPIRED_PROCESS_LRU_CAPACITY
	)
		throw new Error(
			'AckExpiredProcessLogger: you configured expiry logging, and it failed because the process LRU capacity is invalid. Accepted: 1..4096 entries. Fix: use the bounded default. Debug: inspect the logging-only cache configuration.',
		)
	const seen = new Map<string, true>()
	return async (
		result: AckEvidenceExpired,
		logger?: AckExpiredLogger,
	): Promise<void> => {
		let warn: AckExpiredLogger['warn'] | undefined
		try {
			warn = logger?.warn
		} catch {
			return
		}
		if (typeof warn !== 'function') return
		const contactVersionHash = createHash('sha256')
			.update(JSON.stringify([result.contactId, result.profileVersion]))
			.digest('hex')
		if (seen.has(contactVersionHash)) {
			seen.delete(contactVersionHash)
			seen.set(contactVersionHash, true)
			return
		}
		// Claim before awaiting the logger so concurrent callbacks cannot
		// double-log in this process. A failing sink must not retry the SDK.
		seen.set(contactVersionHash, true)
		if (seen.size > capacity) seen.delete(seen.keys().next().value!)
		try {
			await warn.call(logger, ACK_EXPIRED_LOG_SIGNAL, {
				contactVersionHash,
				profileVersion: result.profileVersion,
				suppression: 'bounded-process-local-lru',
				message:
					'AckEvidenceExpired: you attempted a frozen profile acknowledgement, and it failed because original receiver evidence has expired. Accepted: a terminal expired result with retained native debt still owed. Fix: do not reconstruct history, recapture, refresh confirmation age or retry this ACK. Debug: inspect the original SDK reference; log suppression is process-local, not distributed.',
			})
		} catch {
			/* Missing/failing observability never turns expiry into a retry. */
		}
	}
}

export const logAckEvidenceExpiredOncePerProcess =
	createAckExpiredProcessLogger()
