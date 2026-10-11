import { expect, it } from 'vitest'
import { buyPathSchema } from './schema'
const event = { telemetrySchemaVersion: 1, occurredAt: '2026-01-01T00:00:00.000Z', buyPathId: 'cs_test_fixture', purchaseId: 'purchase_fixture', productId: 'product_fixture', userId: null, step: 'post_purchase_started', outcome: 'ok', durationMs: 0, sincePaymentMs: null, source: 'server' }
it('accepts printable function IDs with spaces up to 200 characters', () => {
 expect(buyPathSchema.safeParse({ ...event, functionId: 'Post Purchase Followup Workflow-post-purchase-workflow' }).success).toBe(true)
 expect(buyPathSchema.safeParse({ ...event, functionId: 'x'.repeat(200) }).success).toBe(true)
 expect(buyPathSchema.safeParse({ ...event, functionId: 'x'.repeat(201) }).success).toBe(false)
})
it.each(['\n', '\r', '\t', '\0', '\u007f', '\u0085', '\u2028', '\u2029', '\u200b'])('rejects non-printable function-ID code point %j', (character) => {
 expect(buyPathSchema.safeParse({ ...event, functionId: `function${character}forged` }).success).toBe(false)
})
