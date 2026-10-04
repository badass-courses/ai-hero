import { assign, fromPromise, setup } from 'xstate'
import type { InvoiceLinkResult } from './invoice-links'

type ShareOperation = 'copy' | 'rotate'
/** ready -> working(copy|rotate) -> ready(success|error); no overlapping calls. */
export function createInvoiceShareMachine({
	mint,
	rotate,
	copy,
}: {
	mint(): Promise<InvoiceLinkResult>
	rotate(): Promise<InvoiceLinkResult>
	copy(path: string): Promise<void>
}) {
	return setup({
		types: {
			context: {} as { operation: ShareOperation; message: string },
			events: {} as { type: 'COPY' } | { type: 'ROTATE' },
		},
		actors: {
			share: fromPromise<string, ShareOperation>(async ({ input }) => {
				const result = input === 'rotate' ? await rotate() : await mint()
				if (result.state !== 'minted') throw new Error(result.error)
				if (input === 'rotate')
					return 'Link rotated. Previous links no longer work.'
				await copy(result.invoicePath)
				return 'Share link copied.'
			}),
		},
	}).createMachine({
		id: 'invoice-share',
		initial: 'ready',
		context: { operation: 'copy', message: '' },
		states: {
			ready: {
				on: {
					COPY: {
						target: 'working',
						actions: assign({ operation: 'copy', message: '' }),
					},
					ROTATE: {
						target: 'working',
						actions: assign({ operation: 'rotate', message: '' }),
					},
				},
			},
			working: {
				invoke: {
					src: 'share',
					input: ({ context }) => context.operation,
					onDone: {
						target: 'ready',
						actions: assign({ message: ({ event }) => event.output }),
					},
					onError: {
						target: 'ready',
						actions: assign({
							message: 'Could not share this invoice. Please try again.',
						}),
					},
				},
			},
		},
	})
}
