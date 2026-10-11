'use client'

import { clientBuyPathSchema, type ClientBuyPathEvent } from './schema'

/** Fire-and-forget telemetry must never interrupt checkout or navigation. */
export function createBuyPathLogger(
	buyPathId: string,
	transport: (event: ClientBuyPathEvent) => void = send,
	productId?: string,
) {
	const started = Date.now()
	let polls = 0
	return (
		step: ClientBuyPathEvent['step'],
		options: {
			attempt?: number
			durationMs?: number
			outcome?: ClientBuyPathEvent['outcome']
		} = {},
	) => {
		if (step === 'client_polling' && polls++ >= 46) return
		const event = clientBuyPathSchema.safeParse({
			buyPathId,
			...(productId ? { productId } : {}),
			step,
			durationMs: options.durationMs ?? Date.now() - started,
			outcome: options.outcome ?? 'ok',
			...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
		})
		if (!event.success) return
		try {
			transport(event.data)
		} catch {
			/* Telemetry is not checkout authority. */
		}
	}
}
function send(event: ClientBuyPathEvent) {
	const body = JSON.stringify(event)
	if (
		navigator.sendBeacon?.(
			'/api/telemetry/buy-path',
			new Blob([body], { type: 'application/json' }),
		)
	)
		return
	void fetch('/api/telemetry/buy-path', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body,
		keepalive: true,
	}).catch(() => {})
}

let pricingView: { location: string; id: string } | undefined
export function pricingBuyPathId() {
	const view = location.pathname + location.search
	if (pricingView?.location === view) return pricingView.id
	const id = `pre_${crypto.randomUUID()}`
	pricingView = { location: view, id }
	document.cookie = `buy_path_pre=${id}; Path=/; SameSite=Lax; Max-Age=1800;${location.protocol === 'https:' ? ' Secure;' : ''}`
	return id
}
