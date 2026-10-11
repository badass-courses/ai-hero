import { assign, fromPromise, setup } from 'xstate'
import { z } from 'zod'
import { type PurchaseWaitLogger } from '../../_components/post-purchase-telemetry'

// checking.polling -> checking.waiting -> checking.polling
// checking -> ready | failed; RETRY starts a fresh bounded check.
// Slow copy at 10s, terminal at 90s. Exiting checking cancels the request.
// Processing is not evidence of a failed payment or a failed webhook.
export const CheckoutStatusSchema = z.discriminatedUnion('status', [
	z.object({
		status: z.literal('ready'),
		purchaseId: z.string(),
		product: z
			.object({ name: z.string(), image: z.string().nullable() })
			.nullable()
			.optional(),
	}),
	z.object({ status: z.literal('processing') }),
	z.object({ status: z.literal('error'), message: z.string() }),
])
export type CheckoutStatus = z.infer<typeof CheckoutStatusSchema>
export const CHECK_TIMEOUT_MS = 90_000

export function createPurchaseWaitMachine({
	check,
	logger = () => undefined,
}: {
	check: (attempt: number, signal: AbortSignal) => Promise<CheckoutStatus>
	logger?: PurchaseWaitLogger
}) {
	return setup({
		types: {
			context: {} as {
				attempt: number
				slow: boolean
				result: CheckoutStatus | null
				message: string | null
			},
		},
		actors: {
			check: fromPromise(
				({
					input,
					signal,
				}: {
					input: { attempt: number }
					signal: AbortSignal
				}) => check(input.attempt, signal),
			),
		},
		delays: {
			retryDelay: ({ context }) => Math.min(1000 + context.attempt * 250, 3000),
		},
	}).createMachine({
		id: 'purchaseWait',
		initial: 'checking',
		context: { attempt: 0, slow: false, result: null, message: null },
		states: {
			checking: {
				entry: assign({ attempt: 0, slow: false, result: null, message: null }),
				initial: 'polling',
				after: {
					10000: { actions: assign({ slow: true }) },
					[CHECK_TIMEOUT_MS]: { target: 'failed' },
				},
				states: {
					polling: {
						entry: ({ context }) =>
							logger('client_polling', { attempt: context.attempt }),
						invoke: {
							src: 'check',
							input: ({ context }) => ({ attempt: context.attempt }),
							onDone: [
								{
									guard: ({ event }) => event.output.status === 'ready',
									target: '#purchaseWait.ready',
									actions: assign({ result: ({ event }) => event.output }),
								},
								{
									guard: ({ event }) => event.output.status === 'error',
									target: '#purchaseWait.failed',
									actions: assign({
										message: ({ event }) =>
											event.output.status === 'error'
												? event.output.message
												: null,
									}),
								},
								{ target: 'waiting' },
							],
							onError: { target: 'waiting' },
						},
					},
					waiting: {
						entry: assign({ attempt: ({ context }) => context.attempt + 1 }),
						after: { retryDelay: { target: 'polling' } },
					},
				},
			},
			ready: {
				entry: () => logger('purchase_visible'),
				type: 'final',
			},
			failed: {
				entry: ({ context }) =>
					logger('client_polling', {
						attempt: context.attempt,
						outcome: 'failed',
					}),
				on: { RETRY: 'checking' },
			},
		},
	})
}
