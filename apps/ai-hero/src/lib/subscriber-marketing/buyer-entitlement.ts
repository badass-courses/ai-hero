import { requestBuyerProfileSync } from './buyer-profile-sync'
import type { CaptureMarketingRepository } from './capture-contact-event'
import type { ContactEventWriteRepository } from './contact-event-normalizer-preview'
import {
	ensureBuyerContact,
	writeEntitlementRecordedContactEvents,
	type EntitlementRecordedSource,
} from './lifecycle-contact-events'

/** Record access alongside any purchase fact, including a redeemed seat's
 * purchase capture. This adds no Purchase row, consent, or journey entry.
 */
export async function recordBuyerEntitlement(args: {
	repository: ContactEventWriteRepository &
		Pick<CaptureMarketingRepository, 'createContactAndProviderIdentity'>
	source: EntitlementRecordedSource
	warn?: (event: string, fields: Record<string, unknown>) => unknown
}) {
	await ensureBuyerContact({
		repository: args.repository,
		buyer: args.source,
		warn: args.warn,
	})
	const result = await writeEntitlementRecordedContactEvents({
		repository: args.repository,
		rows: [args.source],
		redispatchDuplicates: true,
	})
	requestBuyerProfileSync(result)
	return result
}
