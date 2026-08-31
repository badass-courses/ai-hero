import { env } from '@/env.mjs'
import { log } from '@/server/logger'
import { Effect } from 'effect'
import { after } from 'next/server'

import type {
	DrovrParityReceiptSink,
	DrovrParityTransitionReceipt,
} from './email-course/parity-receipt'

export type {
	DrovrParityReceiptSink,
	DrovrParityTransitionReceipt,
} from './email-course/parity-receipt'

type DrovrParityConfig = {
	readonly ingestUrl?: string
	readonly apiKey?: string
}

type DrovrParityOptions = {
	readonly config?: DrovrParityConfig
	readonly fetch?: typeof fetch
	readonly warn?: typeof log.warn
	readonly timeoutMs?: number
	readonly schedule?: (task: () => Promise<void>) => void
}

export function deriveDrovrParityTransitionUrl(
	ingestUrl: string,
): string | undefined {
	try {
		const url = new URL(ingestUrl)
		url.pathname = '/parity/transitions'
		url.search = ''
		url.hash = ''
		return url.toString()
	} catch {
		return undefined
	}
}

export async function emitDrovrParityReceipt(
	receipt: DrovrParityTransitionReceipt,
	options: DrovrParityOptions = {},
): Promise<void> {
	const config = effectiveConfig(options.config)
	const parityUrl = config.ingestUrl
		? deriveDrovrParityTransitionUrl(config.ingestUrl)
		: undefined
	if (!parityUrl || !config.apiKey) return

	const warn = options.warn ?? log.warn
	const controller = new AbortController()
	const timeout = setTimeout(
		() => controller.abort(),
		options.timeoutMs ?? 3000,
	)
	try {
		const response = await (options.fetch ?? fetch)(parityUrl, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${config.apiKey}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify(receipt),
			signal: controller.signal,
		})
		if (response.status === 200 || response.status === 202) return
		await warnWithoutThrow(warn, 'drovr.parity.unaccepted_response', {
			status: response.status,
			journeyId: receipt.journeyId,
			cause: receipt.cause,
		})
	} catch (cause) {
		await warnWithoutThrow(warn, 'drovr.parity.emit_failed', {
			journeyId: receipt.journeyId,
			cause: receipt.cause,
			error: cause instanceof Error ? cause.message : String(cause),
		})
	} finally {
		clearTimeout(timeout)
	}
}

export function createDrovrParityReceiptSink(
	options: DrovrParityOptions = {},
): DrovrParityReceiptSink {
	const schedule = options.schedule ?? ((task) => after(task))
	return {
		push: (receipt) =>
			Effect.sync(() => {
				const task = () => emitDrovrParityReceipt(receipt, options)
				try {
					schedule(task)
				} catch {
					void task().catch(() => undefined)
				}
			}),
	}
}

function effectiveConfig(config?: DrovrParityConfig): DrovrParityConfig {
	return (
		config ?? {
			ingestUrl: env.DROVR_SHADOW_INGEST_URL,
			apiKey: env.DROVR_SHADOW_API_KEY,
		}
	)
}

async function warnWithoutThrow(
	warn: typeof log.warn,
	event: string,
	data: Parameters<typeof log.warn>[1],
): Promise<void> {
	try {
		await warn(event, data)
	} catch {
		// Parity telemetry cannot become part of the authoritative commit result.
	}
}
