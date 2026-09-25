import { isSignedInAs, type EnrolmentIdentity } from '@/lib/enrolment-identity'
import { log } from '@/server/logger'

/**
 * A reader ai-hero has verified (signed in as the address) whom Kit still
 * holds unconfirmed after a signup. Kit sends such readers nothing, cannot be
 * made to resend its confirmation, and cannot be confirmed on their behalf
 * (support cnv_1ojzdqat, 2026-09-25: 64 of 1,226 unconfirmed signups in 11
 * days had a verified ai-hero address). Logged so support can see them.
 *
 * Most of these are first-time signups who confirm within minutes; the
 * stranded ones are re-submits, whom Kit created well before this signup
 * and who are still unconfirmed. `resubmit` marks those: Kit's created_at
 * more than RESUBMIT_AFTER_MS before now (false when Kit gave no time).
 *
 * Kit id, intent key, and identity source only: never the address. Never
 * throws into the signup it observes.
 */
export const RESUBMIT_AFTER_MS = 5 * 60_000

export async function reportVerifiedUnconfirmed(args: {
	identity: Pick<EnrolmentIdentity, 'email' | 'via'>
	subscriber: {
		id: number | string
		state?: string | null
		created_at?: string | null
	}
	intentKey: string
	now?: number
}): Promise<void> {
	if (args.subscriber.state === 'active') return
	try {
		if (!(await isSignedInAs(args.identity))) return
		await log.warn('kit.subscriber.verified_unconfirmed', {
			kitSubscriberId: String(args.subscriber.id),
			intentKey: args.intentKey,
			via: args.identity.via,
			state: args.subscriber.state ?? 'unknown',
			...creationEvidence(args.subscriber.created_at, args.now ?? Date.now()),
		})
	} catch {
		// Observability only; the signup's own answer stands.
	}
}

function creationEvidence(createdAt: string | null | undefined, now: number) {
	const created = createdAt ? Date.parse(createdAt) : Number.NaN
	if (!Number.isFinite(created)) return { kitCreatedAt: null, resubmit: false }
	return {
		kitCreatedAt: createdAt!,
		resubmit: now - created > RESUBMIT_AFTER_MS,
	}
}
