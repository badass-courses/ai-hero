import type { KitDirectorySubscriber } from '@/inngest/events/kit-directory'

import {
	resolveOrCreateCaptureIdentity,
	type CaptureMarketingRepository,
} from './capture-contact-event'
import { normalizeContactEvent } from './normalize-contact-event'

export const KIT_DIRECTORY_BATCH_SIZE = 500 as const
export const KIT_DIRECTORY_CONTACT_RETRY_DELAY_MS = 5_000 as const
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

export type KitDirectoryFailure = {
	id: string
	reason: string
}

export type KitDirectoryIngestResult = {
	mode: KitDirectoryIngestMode
	counts: KitDirectoryIngestCounts
	failed: KitDirectoryFailure[]
	cursor?: string
}

type ErrorLike = {
	cause?: unknown
	code?: unknown
	message?: unknown
	name?: unknown
}

function errorChain(error: unknown) {
	const chain: ErrorLike[] = []
	let current = error
	for (
		let depth = 0;
		depth < 5 && current && typeof current === 'object';
		depth++
	) {
		const candidate = current as ErrorLike
		chain.push(candidate)
		current = candidate.cause
	}
	return chain
}

export function kitDirectoryFailureReason(
	error: unknown,
	subscriberEmail?: string,
) {
	const chain = errorChain(error)
	const detail = [...chain]
		.reverse()
		.find(({ message }) => typeof message === 'string')
	const name =
		detail?.name ?? chain.find(({ name }) => typeof name === 'string')?.name
	const code = [...chain]
		.reverse()
		.find(({ code }) => ['number', 'string'].includes(typeof code))?.code
	const message =
		detail?.message ??
		(typeof error === 'string' ? error : 'Unknown error')
	let reason = `${typeof name === 'string' ? name : 'Error'}${code !== undefined ? ` [${String(code)}]` : ''}: ${String(message)}`
	if (subscriberEmail?.trim()) {
		const email = subscriberEmail.trim()
		reason = reason
			.replaceAll(email, '[REDACTED_EMAIL]')
			.replaceAll(encodeURIComponent(email), '[REDACTED_EMAIL]')
	}
	return reason
		.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
		.replace(/\s+/g, ' ')
		.trim()
}

function wait(milliseconds: number) {
	return new Promise<void>((resolveWait) => setTimeout(resolveWait, milliseconds))
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
	contactFailureAttempts?: number
	contactFailureRetryDelayMs?: number
	sleep?: (milliseconds: number) => Promise<void>
	now?: string
}): Promise<KitDirectoryIngestResult> {
	if (args.batch.length > KIT_DIRECTORY_BATCH_SIZE) {
		throw new Error(`Kit directory batches cannot exceed ${KIT_DIRECTORY_BATCH_SIZE}`)
	}

	const contactFailureAttempts = args.contactFailureAttempts ?? 1
	if (!Number.isInteger(contactFailureAttempts) || contactFailureAttempts < 1) {
		throw new Error('Contact failure attempts must be a positive integer')
	}
	const contactFailureRetryDelayMs =
		args.contactFailureRetryDelayMs ?? KIT_DIRECTORY_CONTACT_RETRY_DELAY_MS
	if (
		!Number.isInteger(contactFailureRetryDelayMs) ||
		contactFailureRetryDelayMs < 0
	) {
		throw new Error('Contact failure retry delay must be a non-negative integer')
	}

	const now = args.now ?? new Date().toISOString()
	const sleep = args.sleep ?? wait
	const counts: KitDirectoryIngestCounts = {
		processed: 0,
		created: 0,
		alreadyPresent: 0,
		wouldCreate: 0,
		skippedInvalid: 0,
		failed: 0,
	}
	const failed: KitDirectoryFailure[] = []
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

		for (let attempt = 1; attempt <= contactFailureAttempts; attempt++) {
			try {
				const existing = await args.repository.findProviderIdentity('kit', id)
				if (existing) {
					counts.alreadyPresent += 1
					break
				}
				if (args.dryRun) {
					counts.wouldCreate += 1
					break
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
				break
			} catch (error) {
				if (!args.continueOnContactError) throw error
				const failure: KitDirectoryFailure = {
					id,
					reason: kitDirectoryFailureReason(error, subscriber.email),
				}
				console.error(
					`kit-directory-ingest contact-failed id=${id} attempt=${attempt}/${contactFailureAttempts} reason=${failure.reason}`,
				)
				if (attempt < contactFailureAttempts) {
					await sleep(contactFailureRetryDelayMs)
					continue
				}
				counts.failed += 1
				failed.push(failure)
			}
		}
	}

	return {
		mode: args.dryRun ? 'dry-run' : 'write',
		counts,
		failed,
		cursor,
	}
}
