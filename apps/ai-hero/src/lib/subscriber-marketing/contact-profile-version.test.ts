import { describe, expect, it } from 'vitest'

import { createMemoryContactProfileVersionStore } from './contact-profile-version'

describe('contact profile version', () => {
	it('counts each contact from 1 on its own', async () => {
		const store = createMemoryContactProfileVersionStore()
		await expect(store.versionFor('c1', 'x')).resolves.toMatchObject({
			profileVersion: 1,
		})
		await expect(store.versionFor('c2', 'x')).resolves.toMatchObject({
			profileVersion: 1,
		})
		await expect(store.versionFor('c1', 'y')).resolves.toMatchObject({
			profileVersion: 2,
		})
	})

	it('keeps the version (and when it was set) while the content hash is unchanged', async () => {
		let clock = '2026-09-26T18:00:00.000Z'
		const store = createMemoryContactProfileVersionStore({ now: () => clock })
		await expect(store.versionFor('c1', 'hash-a')).resolves.toEqual({
			profileVersion: 1,
			since: '2026-09-26T18:00:00.000Z',
			acknowledged: false,
		})
		clock = '2026-09-26T18:15:00.000Z'
		for (let run = 0; run < 3; run += 1)
			await expect(store.versionFor('c1', 'hash-a')).resolves.toEqual({
				profileVersion: 1,
				since: '2026-09-26T18:00:00.000Z',
				acknowledged: false,
			})
		await expect(store.versionFor('c1', 'hash-b')).resolves.toEqual({
			profileVersion: 2,
			since: '2026-09-26T18:15:00.000Z',
			acknowledged: false,
		})
		// Changing back is a change too: drovr keeps the highest version.
		await expect(store.versionFor('c1', 'hash-a')).resolves.toMatchObject({
			profileVersion: 3,
		})
	})

	it('hands concurrent new contents distinct versions', async () => {
		const store = createMemoryContactProfileVersionStore()
		const versions = await Promise.all(
			['a', 'b', 'c', 'd'].map((hash) => store.versionFor('c1', hash)),
		)
		expect(
			versions.map((version) => version.profileVersion).sort((a, b) => a - b),
		).toEqual([1, 2, 3, 4])
	})

	it('is acknowledged only once drovr accepted that exact version', async () => {
		const store = createMemoryContactProfileVersionStore()
		await expect(store.versionFor('c1', 'a')).resolves.toMatchObject({
			profileVersion: 1,
			acknowledged: false,
		})
		await store.acknowledge('c1', 1)
		await expect(store.versionFor('c1', 'a')).resolves.toMatchObject({
			profileVersion: 1,
			acknowledged: true,
		})
		// New content is a new version, unacknowledged until drovr takes it.
		await expect(store.versionFor('c1', 'b')).resolves.toMatchObject({
			profileVersion: 2,
			acknowledged: false,
		})
		// A late ack of an older version does not vouch for the current one.
		await store.acknowledge('c1', 1)
		await expect(store.versionFor('c1', 'b')).resolves.toMatchObject({
			profileVersion: 2,
			acknowledged: false,
		})
	})
})
