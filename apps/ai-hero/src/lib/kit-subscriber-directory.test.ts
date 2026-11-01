import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { describe, expect, it, vi } from 'vitest'

import {
	parseKitSubscriberId,
	readKitSubscriberContact,
	readKitSubscriberIdentity,
} from './kit-subscriber-directory'

/**
 * The directory lookup on its own, through an injected reader. No caller in
 * this file reads cookies or links.
 */

vi.mock('@/db', () => ({ db: {} }))

const dialect = new MySqlDialect()

/** The bound values of a drizzle `where`, in order. */
function whereParams(args: unknown): unknown[] {
	const where = (args as { where?: unknown })?.where
	return dialect.sqlToQuery(where as never).params
}

function directory(
	identities: Record<string, string>,
	contacts: Record<string, { email: string | null; name: string | null }>,
) {
	const reads: unknown[][] = []
	return {
		reads,
		reader: {
			query: {
				providerIdentity: {
					findFirst: async (args: unknown) => {
						const [provider, externalId] = whereParams(args)
						reads.push([provider, externalId])
						if (provider !== 'kit') return undefined
						const contactId = identities[String(externalId)]
						return contactId ? { contactId } : undefined
					},
				},
				contact: {
					findFirst: async (args: unknown) => {
						const [id] = whereParams(args)
						return contacts[String(id)]
					},
				},
			},
		},
	}
}

describe('readKitSubscriberIdentity', () => {
	it('names the contact behind a Kit id', async () => {
		const { reader } = directory(
			{ '1234567': 'contact-1' },
			{ 'contact-1': { email: ' reader@example.test ', name: 'Reader' } },
		)

		await expect(
			readKitSubscriberIdentity('"1234567"', reader),
		).resolves.toEqual({
			id: 1234567,
			email_address: 'reader@example.test',
			first_name: 'Reader',
		})
	})

	it('returns null for an id the directory does not know', async () => {
		const { reader } = directory({}, {})
		await expect(readKitSubscriberIdentity('42', reader)).resolves.toBeNull()
	})

	it('returns null for a contact with no address', async () => {
		const reader = {
			query: {
				providerIdentity: { findFirst: async () => ({ contactId: 'c' }) },
				contact: { findFirst: async () => ({ email: '  ', name: null }) },
			},
		}
		await expect(readKitSubscriberIdentity('42', reader)).resolves.toBeNull()
	})

	it('never sends a malformed id to the database', async () => {
		const { reader, reads } = directory({}, {})
		await expect(
			readKitSubscriberIdentity('1 OR 1=1', reader),
		).resolves.toBeNull()
		expect(reads).toEqual([])
	})

	it('lets a failed directory read throw', async () => {
		const reader = {
			query: {
				providerIdentity: {
					findFirst: async () => {
						throw new Error('directory unavailable')
					},
				},
				contact: { findFirst: async () => undefined },
			},
		}
		await expect(readKitSubscriberIdentity('42', reader)).rejects.toThrow(
			'directory unavailable',
		)
	})

	it.each([
		['42', '42'],
		['"42"', '42'],
		[42, '42'],
		[' 0042 ', '42'],
		['0', null],
		['-1', null],
		['4.2', null],
		['abc', null],
		['99999999999999999999', null],
		[null, null],
	])('normalizes %j to %j', (input, expected) => {
		expect(parseKitSubscriberId(input)).toBe(expected)
	})
})

describe('readKitSubscriberContact', () => {
	it('adds the contact id to the same lookup', async () => {
		const { reader } = directory(
			{ '1234567': 'contact-1' },
			{ 'contact-1': { email: 'reader@example.test', name: null } },
		)

		await expect(readKitSubscriberContact(1234567, reader)).resolves.toEqual({
			id: 1234567,
			contactId: 'contact-1',
			email: 'reader@example.test',
		})
	})
})
