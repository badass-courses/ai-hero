import { requestBuyerProfileSync } from './buyer-profile-sync'
import type { CaptureMarketingRepository } from './capture-contact-event'
import type { ContactEventWriteRepository } from './contact-event-normalizer-preview'
import {
	ensureBuyerContact,
	writeEntitlementRecordedContactEvents,
	type EntitlementRecordedSource,
} from './lifecycle-contact-events'

/** Ownership only: no synthetic paid purchase, consent, or journey entry. */
export async function recordBuyerEntitlement(args: {
	repository: ContactEventWriteRepository &
		Pick<CaptureMarketingRepository, 'createContactAndProviderIdentity'>
	source: EntitlementRecordedSource
}) {
	await ensureBuyerContact({ repository: args.repository, buyer: args.source })
	const result = await writeEntitlementRecordedContactEvents({
		repository: args.repository,
		rows: [args.source],
		redispatchDuplicates: true,
	})
	requestBuyerProfileSync(result)
	return result
}
