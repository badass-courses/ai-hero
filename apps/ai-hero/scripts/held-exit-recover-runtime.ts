import type { CaptureMarketingRepository } from '../src/lib/subscriber-marketing/capture-contact-event'
import type { RecoveryRuntime, RecoverySnapshot } from './held-exit-recover'
import { RecoveryRefused } from './held-exit-recover'

export type RecoveryPortOptions = {
	repository: Pick<CaptureMarketingRepository, 'findContactById' | 'createContactEvent'> &
		Required<Pick<CaptureMarketingRepository, 'findContactEventsByType'>>
	findRows: (contactId: string) => Promise<RecoverySnapshot['rows']>
	findKitIdentities: (contactId: string) => Promise<RecoverySnapshot['identities']>
	readOutbox: (lookup: { contactId: string; tenantId: string; journeyId: string; idempotencyKey: string }) =>
		Promise<{ status: 'pending' | 'delivered' | 'rejected' | 'held'; attempts: number }[]>
	apiKey: string
	eventKey: string
	fetch: typeof fetch
	now: () => string
}

export function createHeldRecoveryPorts(options: RecoveryPortOptions): RecoveryRuntime {
	throw new RecoveryRefused({ reason: 'runtime-unavailable' })
}
