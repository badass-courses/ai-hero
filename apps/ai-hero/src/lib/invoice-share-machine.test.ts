import { createActor, waitFor } from 'xstate'
import { describe, expect, it, vi } from 'vitest'
import { createInvoiceShareMachine } from './invoice-share-machine'
import type { InvoiceLinkResult } from './invoice-links'

const link = '/invoices/mc_synthetic?t=synthetic-token'
const minted: InvoiceLinkResult = { state: 'minted', invoicePath: link }

describe('invoice share lifecycle', () => {
	it('mints and copies once without keeping the token in machine context', async () => {
		const mint = vi.fn(async () => minted)
		const copy = vi.fn(async () => {})
		const actor = createActor(
			createInvoiceShareMachine({ mint, rotate: mint, copy }),
		).start()
		actor.send({ type: 'COPY' })
		await waitFor(
			actor,
			(state) => state.context.message === 'Share link copied.',
		)
		expect(mint).toHaveBeenCalledOnce()
		expect(copy).toHaveBeenCalledWith(link)
		expect(JSON.stringify(actor.getSnapshot().context)).not.toContain(
			'synthetic-token',
		)
		actor.stop()
	})
	it('does not overlap rotation with an in-flight mint', async () => {
		let finish: (result: InvoiceLinkResult) => void = () => {
			throw new Error('Promise not initialized')
		}
		const mint = vi.fn(
			() =>
				new Promise<InvoiceLinkResult>((resolve) => {
					finish = resolve
				}),
		)
		const rotate = vi.fn(async () => minted)
		const actor = createActor(
			createInvoiceShareMachine({ mint, rotate, copy: async () => {} }),
		).start()
		actor.send({ type: 'COPY' })
		expect(actor.getSnapshot().matches('working')).toBe(true)
		actor.send({ type: 'ROTATE' })
		expect(rotate).not.toHaveBeenCalled()
		finish(minted)
		await waitFor(
			actor,
			(state) => state.context.message === 'Share link copied.',
		)
		actor.stop()
	})
	it('announces rotation without copying or retaining the new token', async () => {
		const copy = vi.fn(async () => {})
		const actor = createActor(
			createInvoiceShareMachine({
				mint: async () => minted,
				rotate: async () => minted,
				copy,
			}),
		).start()
		actor.send({ type: 'ROTATE' })
		await waitFor(actor, (state) =>
			state.context.message.startsWith('Link rotated.'),
		)
		expect(copy).not.toHaveBeenCalled()
		expect(JSON.stringify(actor.getSnapshot().context)).not.toContain(
			'synthetic-token',
		)
		actor.stop()
	})
	it('does not copy after server authorization is refused', async () => {
		const copy = vi.fn(async () => {})
		const actor = createActor(
			createInvoiceShareMachine({
				mint: async () => ({ state: 'denied', error: 'Not authorized' }),
				rotate: async () => minted,
				copy,
			}),
		).start()
		actor.send({ type: 'COPY' })
		await waitFor(actor, (state) =>
			state.context.message.startsWith('Could not share'),
		)
		expect(copy).not.toHaveBeenCalled()
		expect(actor.getSnapshot().matches('ready')).toBe(true)
		actor.stop()
	})
})
