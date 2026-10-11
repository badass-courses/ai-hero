import { beforeEach, expect, it, vi } from 'vitest'
import { Inngest } from 'inngest'
import { buyPathSchema } from './schema'
import { emitBuyPath } from './server'
const sink = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }))
vi.mock('@/server/logger', () => ({ log: sink }))
beforeEach(() => { vi.clearAllMocks() })
const client = new Inngest({ id: 'ai-hero' })
const fn = client.createFunction(
	{ id: 'post-purchase-workflow', name: 'Post Purchase Followup Workflow' },
	{ event: 'commerce/new-purchase-created' },
	async () => null,
)
const functionId = fn.id(fn.name)
it.each(['post_purchase_started', 'post_purchase_finished'] as const)(
	'accepts real SDK function identifiers through the %s emitter',
	async (step) => {
		expect(functionId).toContain('Post Purchase Followup Workflow')
		await emitBuyPath(
			{
				buyPathId: 'cs_test_fixture',
				purchaseId: 'purchase_fixture',
				productId: 'product_fixture',
				userId: 'user_fixture',
				paymentAt: Date.now() - 1000,
			},
			step,
			{ functionId, runId: '01KTESTFUNCTIONRUN', durationMs: 100 },
		)
		expect(sink.error).not.toHaveBeenCalled()
		expect(sink.info).toHaveBeenCalledOnce()
		const [name, event] = sink.info.mock.calls[0]
		expect(name).toBe(`buy_path.${step}`)
		expect(buyPathSchema.safeParse(event).success).toBe(true)
		expect(event).toMatchObject({
			step,
			functionId,
			runId: '01KTESTFUNCTIONRUN',
		})
	},
)
it('still rejects invalid entity IDs and control characters in function identifiers', async () => {
	await emitBuyPath(
		{
			buyPathId: 'cs_test_fixture',
			purchaseId: 'not an entity ID',
			productId: null,
			userId: null,
		},
		'post_purchase_started',
		{ functionId },
	)
	expect(sink.info).not.toHaveBeenCalled()
	expect(sink.error).toHaveBeenCalledWith(
		'buy_path.invalid_event',
		expect.any(Object),
	)
	sink.error.mockClear()
	await emitBuyPath(
		{
			buyPathId: 'cs_test_fixture',
			purchaseId: null,
			productId: null,
			userId: null,
		},
		'post_purchase_started',
		{ functionId: 'name\nforged-log' },
	)
	expect(sink.info).not.toHaveBeenCalled()
	expect(sink.error).toHaveBeenCalledOnce()
})
