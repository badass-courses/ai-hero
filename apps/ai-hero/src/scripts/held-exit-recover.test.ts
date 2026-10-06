import { describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'
import { buildDrovrSignupRequest } from '../lib/subscriber-marketing/drovr-doi-signup'
import { resolveRecoveryContact, runHeldExitRecovery, type RecoveryRuntime } from '../../scripts/held-exit-recover'
import type { SideEffectIntent } from '../lib/subscriber-marketing/types'
import { InMemorySubscriberMarketingRepository } from '../lib/subscriber-marketing/dry-run'
import { readOldSequenceMembership, OLD_NEWSLETTER_EXIT_CONFIRMED, OLD_NEWSLETTER_REFERENCE } from '../lib/subscriber-marketing/old-newsletter-exit'
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
function runtime(): RecoveryRuntime & { repository: InMemorySubscriberMarketingRepository } {
	const repository = new InMemorySubscriberMarketingRepository()
	return {
		repository,
		now: () => contact.createdAt,
		currentMembership: async (id) => readOldSequenceMembership(repository, id),
		findContactById: async (id) => id === contact.id ? contact : undefined,
		inspect: async () => ({ rows: [structuredClone(held)], identities: [
			{ id: 'fixture-identity', contactId: contact.id, externalId: '123' }],
			history: repository.findContactEventsByType(contact.id, OLD_NEWSLETTER_EXIT_CONFIRMED) }),
		scan: async () => scan,
		persist: vi.fn(async (input) => repository.createContactEvent(input)),
		notify: vi.fn(async () => 1),
	}
}
const dryRun = { mode: 'dry-run' as const, namespace: 'ai-hero' as const, contactId: contact.id }

describe('single-contact held exit recovery', () => {
	it('writes the established current exit proof before its replay notification, then refuses a recovered row', async () => {
		const ports = runtime()
		const planned = await Effect.runPromise(runHeldExitRecovery(dryRun, ports))
		if (!planned.planHash) throw new Error('Missing test plan')
		ports.notify = vi.fn(async ({ contactId, receiptId }) => {
			const proofs = ports.repository.findContactEventsByType(contactId, OLD_NEWSLETTER_EXIT_CONFIRMED)
			expect(proofs).toHaveLength(1)
			expect(proofs[0]).toMatchObject({ id: receiptId, provider: 'kit',
				providerReference: OLD_NEWSLETTER_REFERENCE, occurredAt: scan.startedAt })
			expect(await readOldSequenceMembership(ports.repository, contactId)).toBe('exited')
			return 1
		})
		const write = { ...dryRun, mode: 'write' as const, approval: 'fixture-approval', planHash: planned.planHash }
		const result = await Effect.runPromise(runHeldExitRecovery(write, ports))
		expect(result).toMatchObject({ status: 'requested', counts: { exitReceipts: 1, notifications: 1 } })
		expect(ports.notify).toHaveBeenCalledOnce()
		const original = await ports.inspect(contact.id)
		ports.inspect = async () => ({ ...original, rows: [{ ...held, status: 'completed', completedAt: contact.createdAt }] })
		expect(await Effect.runPromise(runHeldExitRecovery(write, ports))).toMatchObject({ status: 'refused', reason: 'already-recovered' })
		expect(ports.persist).toHaveBeenCalledOnce()
		expect(ports.notify).toHaveBeenCalledOnce()
		for (const privateValue of [contact.id, contact.email!, contact.name!, 'fixture-approval'])
			expect(JSON.stringify(result)).not.toContain(privateValue)
	})

	it.each(['approval', 'hash', 'member-after-plan', 'changed-after-scan'])('requires fresh matching write authorization: %s', async (scenario) => {
		const ports = runtime()
		const planned = await Effect.runPromise(runHeldExitRecovery(dryRun, ports))
		if (!planned.planHash) throw new Error('Missing test plan')
		if (scenario === 'member-after-plan') ports.scan = async () => ({ ...scan, membership: 'present' })
		if (scenario === 'changed-after-scan') {
			const original = await ports.inspect(contact.id)
			let reads = 0
			ports.inspect = async () => ++reads === 1 ? original : { ...original, rows: [{ ...held, status: 'pending' }] }
		}
		const result = await Effect.runPromise(runHeldExitRecovery({ ...dryRun, mode: 'write',
			approval: scenario === 'approval' ? '' : 'fixture-approval',
			planHash: scenario === 'hash' ? '0'.repeat(64) : planned.planHash }, ports))
		expect(result).toMatchObject({ status: 'refused', reason: scenario === 'approval' ? 'approval-required' :
			scenario === 'hash' ? 'plan-hash-mismatch' : scenario === 'member-after-plan' ? 'old-sequence-member' : 'snapshot-changed' })
		expect(ports.persist).not.toHaveBeenCalled()
		expect(ports.notify).not.toHaveBeenCalled()
	})
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
