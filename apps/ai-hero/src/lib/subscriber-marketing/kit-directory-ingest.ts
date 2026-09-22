import type { KitDirectorySubscriber } from '@/inngest/events/kit-directory'

import {
	resolveOrCreateCaptureIdentity,
	type CaptureMarketingRepository,
} from './capture-contact-event'
import { normalizeContactEvent } from './normalize-contact-event'

export const KIT_DIRECTORY_BATCH_SIZE = 500 as const
/** The delivery lane for ingest-born directory births, apart from live signups. */
export const KIT_DIRECTORY_DELIVERY_SOURCE = 'kit-directory-ingest' as const

type KitDirectoryIngestMode = 'dry-run' | 'write'

export type KitDirectoryIngestCounts = {
	processed: number
	created: number
	alreadyPresent: number
	wouldCreate: number
	skippedInvalid: number
	failed: number
}

export type KitDirectoryIngestResult = {
	mode: KitDirectoryIngestMode
	counts: KitDirectoryIngestCounts
	failed: string[]
	cursor?: string
}

function isoOrUndefined(value: string | undefined): string | undefined {
	if (!value?.trim()) return undefined
	const parsed = new Date(value)
	return Number.isNaN(parsed.valueOf()) ? undefined : parsed.toISOString()
}

export function kitDirectoryIdentityEvent(args: {
	subscriber: KitDirectorySubscriber
	now: string
}) {
	const id = args.subscriber.id.trim()
	const occurredAt = isoOrUndefined(args.subscriber.createdAt) ?? args.now
	return normalizeContactEvent({
		provider: 'kit',
		providerEventId: `directory-import:${id}`,
		eventType: 'kit.directory-imported',
		occurredAt,
		email: args.subscriber.email,
		name: args.subscriber.name,
		state: args.subscriber.state,
		externalId: id,
		message: 'Kit subscriber imported into the AI Hero contact directory.',
		privacyLevel: 'internal',
	})
}

export async function ingestKitDirectoryBatch(args: {
	repository: CaptureMarketingRepository
	batch: readonly KitDirectorySubscriber[]
	dryRun?: boolean
	suppressBirthDelivery?: boolean
	continueOnContactError?: boolean
	now?: string
}): Promise<KitDirectoryIngestResult> {
	if (args.batch.length > KIT_DIRECTORY_BATCH_SIZE) {
		throw new Error(`Kit directory batches cannot exceed ${KIT_DIRECTORY_BATCH_SIZE}`)
	}

	const now = args.now ?? new Date().toISOString()
	const counts: KitDirectoryIngestCounts = {
		processed: 0,
		created: 0,
		alreadyPresent: 0,
		wouldCreate: 0,
		skippedInvalid: 0,
		failed: 0,
	}
	const failed: string[] = []
	let cursor: string | undefined

	for (const subscriber of args.batch) {
		const id = subscriber.id.trim()
		const numericId = Number(id)
		if (!id || !Number.isFinite(numericId)) {
			counts.skippedInvalid += 1
			continue
		}
		counts.processed += 1
		cursor = id

		try {
			const existing = await args.repository.findProviderIdentity('kit', id)
			if (existing) {
				counts.alreadyPresent += 1
				continue
			}
			if (args.dryRun) {
				counts.wouldCreate += 1
				continue
			}

			const identity = await resolveOrCreateCaptureIdentity({
				repository: args.repository,
				event: kitDirectoryIdentityEvent({ subscriber, now }),
				now,
				creationOptions: {
					deliverySource: KIT_DIRECTORY_DELIVERY_SOURCE,
					...(args.suppressBirthDelivery
						? { suppressBirthDelivery: true }
						: {}),
				},
			})
			if (identity.createdContact) counts.created += 1
			else counts.alreadyPresent += 1
		} catch (error) {
			if (!args.continueOnContactError) throw error
			counts.failed += 1
			failed.push(id)
		}
	}

	return {
		mode: args.dryRun ? 'dry-run' : 'write',
		counts,
		failed,
		cursor,
	}
}
