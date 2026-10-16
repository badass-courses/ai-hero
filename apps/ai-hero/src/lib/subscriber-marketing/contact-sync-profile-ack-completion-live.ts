import { settleAndCompleteProfileAck } from './contact-sync-profile-ack-persistence'
import type {
	AckEvidenceExpired,
	ProfileAckReference,
} from './contact-sync-profile-ack-schema'

export type ProfileAckWorkerCompletion =
	| void
	| AckEvidenceExpired
	| { _tag: 'ProfileAckAwaitingProof' }

/** ACK-only completion: no transport, capture, native mutation or history
 * reconstruction. Called INSIDE the actual SDK ACK effect, never memoized
 * beforehand. The SQL helper rereads/locks original membership and writes the
 * frozen confirmation clock atomically; OFF never uses the legacy NOW writer.
 */
export async function completeProfileAckWorkerReference(args: {
	database: unknown
	ref: ProfileAckReference
	enabled: () => Promise<boolean>
}): Promise<ProfileAckWorkerCompletion> {
	const result = await settleAndCompleteProfileAck({
		...args,
		settledKeys: [args.ref.coordinatorKey],
		settle: async () => 0,
	})
	if (result._tag === 'ProfileAckDisabled')
		return { _tag: 'ProfileAckAwaitingProof' }
	if (result.evaluation._tag === 'AckEvidenceExpired') return result.evaluation
	if (result.evaluation._tag !== 'ProfileAckReady')
		return { _tag: 'ProfileAckAwaitingProof' }
}

export async function completeProfileAckWorkerReferenceLive(
	ref: ProfileAckReference,
): Promise<ProfileAckWorkerCompletion> {
	const [{ db }, { profileAckEnabled }] = await Promise.all([
		import('@/db'),
		import('./contact-sync-profile-ack-flag-live'),
	])
	const result = await completeProfileAckWorkerReference({
		database: db,
		ref,
		enabled: profileAckEnabled,
	})
	if (result?._tag === 'AckEvidenceExpired') {
		try {
			const [{ log }, { logAckEvidenceExpiredOncePerProcess }] =
				await Promise.all([
					import('@/server/logger'),
					import('./contact-sync-profile-ack-expired-log'),
				])
			await logAckEvidenceExpiredOncePerProcess(result, log)
		} catch {
			/* Logging never makes expired evidence retryable. */
		}
	}
	return result
}
