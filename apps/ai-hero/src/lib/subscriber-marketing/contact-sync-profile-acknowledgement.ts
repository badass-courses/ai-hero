import {
	drovrOutboxDedupeKey,
	outboxEntryForEvent,
	type DrovrOutboxRow,
} from './drovr-outbox'
import {
	proveRetryAcknowledgement,
	retryProofRowsLive,
	RETRY_PROOF_MAX_REFERENCES,
} from './contact-sync-retry-acknowledgement'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

export type ProfileDeliveryProofInput = {
	contactId: string
	profileVersion: number
	events: DrovrShadowEvent[]
}

/** A queue receipt or accepted counter is not evidence. All requested scoped
 * profile/link members must have retained terminal receiver receipts, with a
 * delivered matching profile and no held/negative member. First-owned bodies
 * and clocks remain authoritative; never reconstruct or rebase them here. */
export async function proveContactProfileDelivery(
	args: ProfileDeliveryProofInput & {
		target: string
		rows: (
			target: string,
			keys: readonly string[],
		) => Promise<readonly DrovrOutboxRow[]>
	},
): Promise<boolean> {
	if (
		!args.target ||
		!args.events.length ||
		args.events.length > RETRY_PROOF_MAX_REFERENCES ||
		!args.events.some((event) => event.type === 'contact.profile.updated')
	)
		return false
	if (
		args.events.some(
			(event) =>
				event.tenantId !== 'org-aihero' ||
				event.contactId !== args.contactId ||
				event.journeyId !== 'contact-directory' ||
				!['contact.profile.updated', 'contact.links.issued'].includes(
					event.type,
				),
		)
	)
		return false
	const keys = args.events.map((event) =>
		drovrOutboxDedupeKey(args.target, outboxEntryForEvent(event, 'bulkDelta')),
	)
	if (new Set(keys).size !== keys.length) return false
	const expectedTypes = new Map(
		keys.map((key, index) => [key, args.events[index]!.type]),
	)
	const retained = await args.rows(args.target, keys)
	if (
		retained.some((row) => row.eventType !== expectedTypes.get(row.dedupeKey))
	)
		return false
	const proof = await proveRetryAcknowledgement({
		target: args.target,
		phase: 'terminal',
		data: {
			items: [],
			attempt: 0,
			ownedKeys: keys,
			acknowledge: {
				contactId: args.contactId,
				profileVersion: args.profileVersion,
			},
		},
		rows: async () => retained,
	})
	return proof.proved && proof.rejected === 0
}

export async function proveContactProfileDeliveryLive(
	input: ProfileDeliveryProofInput,
): Promise<boolean> {
	const { drovrOutboxTargetFromEnv } = await import('./drovr-outbox-live')
	const target = drovrOutboxTargetFromEnv()
	if (!target) return false
	return proveContactProfileDelivery({
		...input,
		target,
		rows: retryProofRowsLive,
	})
}
