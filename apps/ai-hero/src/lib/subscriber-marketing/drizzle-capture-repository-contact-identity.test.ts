import { beforeEach, describe, expect, it, vi } from 'vitest'

import { contact, providerIdentity } from '@/db/schema'

const dispatchShadowFact = vi.hoisted(() => vi.fn())

vi.mock('./drovr-shadow-dispatch', () => ({
	dispatchDrovrShadowFactSafely: dispatchShadowFact,
}))

import { DrizzleCaptureMarketingRepository } from './drizzle-capture-repository'
import type { ContactRecord, ProviderIdentityRecord } from './types'

function duplicateEntry() {
	return Object.assign(
		new Error("Duplicate entry 'kit-42' for key 'ProviderIdentity_provider_externalId_uq'"),
		{ code: 'ER_DUP_ENTRY', errno: 1062 },
	)
}

function primaryKeyDuplicateEntry(id: string) {
	return Object.assign(
		new Error(
			`Duplicate entry '${id}' for key 'AI_ProviderIdentity.PRIMARY'`,
		),
		{ code: 'ER_DUP_ENTRY', errno: 1062 },
	)
}

const contactInput: Omit<ContactRecord, 'id'> = {
	userId: null,
	email: 'subscriber@example.test',
	name: 'Subscriber',
	lifecycle: 'new',
	isProvisional: true,
	optInAttribution: null,
	createdAt: '2026-09-20T00:00:00.000Z',
	updatedAt: '2026-09-20T00:00:00.000Z',
}

const providerIdentityInput: Omit<
	ProviderIdentityRecord,
	'id' | 'contactId'
> = {
	provider: 'kit',
	externalId: 'kit-42',
	evidence: { source: 'kit', strength: 'strong' },
	createdAt: '2026-09-20T00:00:00.000Z',
	updatedAt: '2026-09-20T00:00:00.000Z',
}

function database(
	options: { identityError?: unknown; identityErrors?: unknown[] } = {},
) {
	const committed: Array<{ table: unknown; value: unknown }> = []
	const attempted: Array<{ table: unknown; value: unknown }> = []
	const identityErrors = [...(options.identityErrors ?? [])]
	const database = {
		transaction: vi.fn(async (write: (tx: unknown) => Promise<unknown>) => {
			const pending: Array<{ table: unknown; value: unknown }> = []
			const transaction = {
				insert: (table: unknown) => ({
					values: async (value: unknown) => {
						attempted.push({ table, value })
						if (table === providerIdentity) {
							const identityError =
								identityErrors.shift() ?? options.identityError
							if (identityError) throw identityError
						}
						pending.push({ table, value })
					},
				}),
			}
			const result = await write(transaction)
			committed.push(...pending)
			return result
		}),
	}
	return { attempted, committed, database }
}

class TestRepository extends DrizzleCaptureMarketingRepository {
	constructor(
		database: unknown,
		private readonly winningIdentity?: ProviderIdentityRecord,
		private readonly winningContact?: ContactRecord,
	) {
		super(database)
	}

	async findProviderIdentity(provider: string, externalId: string) {
		if (
			this.winningIdentity?.provider === provider &&
			this.winningIdentity.externalId === externalId
		) {
			return this.winningIdentity
		}
		return undefined
	}

	async findContactById(id: string) {
		return this.winningContact?.id === id ? this.winningContact : undefined
	}
}

describe('DrizzleCaptureMarketingRepository contact identity creation', () => {
	beforeEach(() => {
		dispatchShadowFact.mockReset()
	})

	it('rolls back the contact and skips the birth fact when identity creation loses a race', async () => {
		const winningContact: ContactRecord = { ...contactInput, id: 'winner' }
		const winningIdentity: ProviderIdentityRecord = {
			...providerIdentityInput,
			id: 'winning-identity',
			contactId: winningContact.id,
		}
		const { attempted, committed, database: writeDatabase } = database({
			identityError: duplicateEntry(),
		})
		const repository = new TestRepository(
			writeDatabase,
			winningIdentity,
			winningContact,
		)

		await expect(
			repository.createContactAndProviderIdentity(
				contactInput,
				providerIdentityInput,
			),
		).resolves.toEqual({
			contact: winningContact,
			providerIdentity: winningIdentity,
			createdContact: false,
			createdProviderIdentity: false,
		})
		expect(committed).toEqual([])
		expect(
			attempted.filter(({ table }) => table === providerIdentity),
		).toHaveLength(1)
		expect(dispatchShadowFact).not.toHaveBeenCalled()
	})

	it('retries a provider identity PRIMARY collision with a new id', async () => {
		const { attempted, committed, database: writeDatabase } = database({
			identityErrors: [primaryKeyDuplicateEntry('3xl4e')],
		})
		const repository = new TestRepository(writeDatabase)
		vi.spyOn(repository, 'newId')
			.mockReturnValueOnce('contact-id')
			.mockReturnValueOnce('3xl4e')
			.mockReturnValueOnce('fresh-id')

		await expect(
			repository.createContactAndProviderIdentity(
				contactInput,
				providerIdentityInput,
			),
		).resolves.toMatchObject({
			createdContact: true,
			createdProviderIdentity: true,
			providerIdentity: { id: 'fresh-id' },
		})

		expect(
			attempted
				.filter(({ table }) => table === providerIdentity)
				.map(({ value }) => (value as ProviderIdentityRecord).id),
		).toEqual(['3xl4e', 'fresh-id'])
		expect(
			committed
				.filter(({ table }) => table === providerIdentity)
				.map(({ value }) => (value as ProviderIdentityRecord).id),
		).toEqual(['fresh-id'])
	})

	it('dispatches one birth fact only after the transaction commits', async () => {
		const phases: string[] = []
		const { committed, database: writeDatabase } = database()
		writeDatabase.transaction.mockImplementationOnce(async (write) => {
			const result = await write({
				insert: (table: unknown) => ({
					values: async (value: unknown) => {
						committed.push({ table, value })
					},
				}),
			})
			phases.push('commit')
			return result
		})
		dispatchShadowFact.mockImplementationOnce(() => {
			phases.push('dispatch')
		})
		const repository = new TestRepository(writeDatabase)

		const result = await repository.createContactAndProviderIdentity(
			contactInput,
			providerIdentityInput,
			{ kitSubscriberId: providerIdentityInput.externalId },
		)

		expect(result).toMatchObject({
			createdContact: true,
			createdProviderIdentity: true,
		})
		expect(committed.map(({ table }) => table)).toEqual([
			contact,
			providerIdentity,
		])
		expect(dispatchShadowFact).toHaveBeenCalledTimes(1)
		expect(dispatchShadowFact).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'contact-created',
				kitSubscriberId: 'kit-42',
			}),
		)
		expect(phases).toEqual(['commit', 'dispatch'])
	})

	it('suppresses birth delivery for the direct contact creation entry point', async () => {
		const committed: Array<{ table: unknown; value: unknown }> = []
		const writeDatabase = {
			insert: (table: unknown) => ({
				values: async (value: unknown) => {
					committed.push({ table, value })
				},
			}),
		}
		const repository = new TestRepository(writeDatabase)

		await repository.createContact(contactInput, {
			kitSubscriberId: providerIdentityInput.externalId,
			suppressBirthDelivery: true,
		})

		expect(committed.map(({ table }) => table)).toEqual([contact])
		expect(dispatchShadowFact).not.toHaveBeenCalled()
	})

	it('commits contact and identity atomically without enqueue or fallback dispatch', async () => {
		const { committed, database: writeDatabase } = database()
		const repository = new TestRepository(writeDatabase)

		const result = await repository.createContactAndProviderIdentity(
			contactInput,
			providerIdentityInput,
			{
				kitSubscriberId: providerIdentityInput.externalId,
				deliverySource: 'kit-directory-ingest',
				suppressBirthDelivery: true,
			},
		)

		expect(result).toMatchObject({
			createdContact: true,
			createdProviderIdentity: true,
		})
		expect(committed.map(({ table }) => table)).toEqual([
			contact,
			providerIdentity,
		])
		expect(dispatchShadowFact).not.toHaveBeenCalled()
	})
})
