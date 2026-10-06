import { describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'
import { buildDrovrSignupRequest } from '../lib/subscriber-marketing/drovr-doi-signup'
import { resolveRecoveryContact, runHeldExitRecovery, type RecoveryRuntime } from '../../scripts/held-exit-recover'
import type { SideEffectIntent } from '../lib/subscriber-marketing/types'
import type { ContactRecord } from '../lib/subscriber-marketing/types'

const contact: ContactRecord = {
	id: 'fixture-contact', email: 'fixture@example.test', name: 'Fixture',
	lifecycle: 'new', isProvisional: false,
	createdAt: '2026-10-06T12:00:00.000Z', updatedAt: '2026-10-06T12:00:00.000Z',
}

const held: SideEffectIntent = {
	id: 'fixture-row', contactId: contact.id, nextActionId: 'fixture-action',
	provider: 'kit', type: 'subscribe-evergreen-list', status: 'held-for-exit',
	idempotencyKey: `contact:${contact.id}:evergreen:list:shadow-newsletter`,
	createdAt: contact.createdAt, gates: [], reviewReasons: ['old-newsletter-exit-unconfirmed'],
	metadata: { list: 'shadow-newsletter', source: 'drovr', drovr: {
		tenantId: 'org-aihero', journeyId: 'crash-course-evergreen-offer', intentKey: 'fixture-original-intent' } },
}
const scan = { membership: 'absent' as const, complete: true, sequenceId: 2625552,
	pages: 2, subscribers: 12, startedAt: contact.createdAt, completedAt: contact.createdAt }
function runtime(): RecoveryRuntime {
	return {
		findContactById: async (id) => id === contact.id ? contact : undefined,
		inspect: async () => ({ rows: [structuredClone(held)], identities: [
			{ id: 'fixture-identity', contactId: contact.id, externalId: '123' }], history: [] }),
		scan: async () => scan,
		persist: vi.fn(async (input) => ({ ...input, id: 'fixture-receipt' })),
		notify: vi.fn(async () => 1),
	}
}
const dryRun = { mode: 'dry-run' as const, namespace: 'ai-hero' as const, contactId: contact.id }

describe('single-contact held exit recovery', () => {
	it.each([
		['zero', 'held-row-count'], ['multiple', 'held-row-count'],
		['unknown', 'membership-unknown'], ['partial', 'membership-unknown'],
		['member', 'old-sequence-member'], ['error', 'provider-unavailable'],
		['recovered', 'already-recovered'], ['wrong-sequence', 'membership-unknown'],
	])('refuses %s evidence without any writes', async (scenario, reason) => {
		const ports = runtime()
		const original = await ports.inspect(contact.id)
		if (scenario === 'zero') original.rows = []
		if (scenario === 'multiple') original.rows.push({ ...held, id: 'fixture-other-row' })
		if (scenario === 'recovered') original.rows = [{ ...held, status: 'completed', completedAt: contact.createdAt }]
		ports.inspect = async () => original
		if (scenario === 'unknown') ports.scan = async () => ({ ...scan, membership: 'unknown' })
		if (scenario === 'partial') ports.scan = async () => ({ ...scan, complete: false })
		if (scenario === 'member') ports.scan = async () => ({ ...scan, membership: 'present' })
		if (scenario === 'wrong-sequence') ports.scan = async () => ({ ...scan, sequenceId: 2757199 })
		if (scenario === 'error') ports.scan = async () => { throw new Error(`private ${contact.email}`) }
		const result = await Effect.runPromise(runHeldExitRecovery(dryRun, ports))
		expect(result).toMatchObject({ status: 'refused', reason, counts: { exitReceipts: 0, notifications: 0 } })
		expect(ports.persist).not.toHaveBeenCalled()
		expect(ports.notify).not.toHaveBeenCalled()
		expect(JSON.stringify(result)).not.toContain(contact.email)
	})
	it('plans one receipt and one replay wakeup without writing or exposing contact data', async () => {
		const ports = runtime()
		const result = await Effect.runPromise(runHeldExitRecovery(dryRun, ports))
		expect(result).toMatchObject({ version: 1, status: 'planned',
			counts: { exitReceipts: 1, notifications: 1 },
			checks: { contactResolved: true, exactlyOneHeld: true, oldSequenceAbsent: true } })
		expect(result.planHash).toMatch(/^[a-f0-9]{64}$/)
		expect(result.scans).toEqual([scan])
		expect(ports.persist).not.toHaveBeenCalled()
		expect(ports.notify).not.toHaveBeenCalled()
		const output = JSON.stringify(result)
		for (const privateValue of [contact.id, contact.email!, contact.name!, held.id, 'fixture-identity', 'fixture-original-intent'])
			expect(output).not.toContain(privateValue)
	})
	it('resolves drovr delivery identity to the same AI Hero contact used by the executor', async () => {
		const delivered = buildDrovrSignupRequest({ contactId: contact.id,
			drovrFormId: 'fixture-form', occurredAt: contact.createdAt,
			submissionId: 'fixture-submission', page: '/fixture' })
		const find = async (id: string) => id === contact.id ? contact : undefined
		expect(await resolveRecoveryContact({ namespace: 'drovr', contactId: delivered.contactId }, find)).toEqual(contact)
		expect(await resolveRecoveryContact({ namespace: 'ai-hero', contactId: contact.id }, find)).toEqual(contact)
	})
})
