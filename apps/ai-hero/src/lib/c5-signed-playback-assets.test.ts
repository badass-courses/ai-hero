import { describe, expect, it, vi } from 'vitest'
import {
	provisionC5SignedPlayback,
	type PlaybackSnapshot,
} from './c5-signed-playback-assets'
import type { C5PlaybackRow } from './c5-signed-playback-inventory'

const row: C5PlaybackRow = {
	resourceId: 'video-fixture',
	assetId: 'asset-fixture',
	publicPlaybackId: 'public-fixture',
	signedPlaybackId: null,
	lessonId: 'lesson-fixture',
	workshopId: 'workshop-fixture',
}
const makeIO = () => ({
	getSignedIds: vi.fn(async () => [] as string[]),
	createSignedId: vi.fn(async () => 'signed-fixture'),
	snapshot: vi.fn((_entry: PlaybackSnapshot) => {}),
	store: vi.fn(
		async (_resourceId: string, _assetId: string, _signedId: string) => {},
	),
})

describe('C5 signed asset provisioning', () => {
	it('journals intent before Mux and the signed ID before the database write', async () => {
		const events: string[] = []
		const io = makeIO()
		io.snapshot.mockImplementation((entry: PlaybackSnapshot) => {
			events.push(entry.phase)
		})
		io.createSignedId.mockImplementation(async () => {
			events.push('mux')
			return 'signed-fixture'
		})
		io.store.mockImplementation(async () => {
			events.push('database')
		})
		expect(await provisionC5SignedPlayback([row], io)).toEqual({ stored: 1 })
		expect(events).toEqual([
			'before_mux',
			'mux',
			'before_database',
			'database',
			'stored',
		])
		expect(io.snapshot).toHaveBeenNthCalledWith(2, {
			resourceId: row.resourceId,
			assetId: row.assetId,
			newSignedId: 'signed-fixture',
			phase: 'before_database',
		})
	})

	it('skips resources already provisioned', async () => {
		const io = makeIO()
		expect(
			await provisionC5SignedPlayback(
				[{ ...row, signedPlaybackId: 'existing' }],
				io,
			),
		).toEqual({ stored: 0 })
		expect(io.getSignedIds).not.toHaveBeenCalled()
		expect(io.store).not.toHaveBeenCalled()
	})

	it('reuses one signed ID across resources sharing an asset', async () => {
		const io = makeIO()
		await provisionC5SignedPlayback(
			[row, { ...row, resourceId: 'another-video' }],
			io,
		)
		expect(io.createSignedId).toHaveBeenCalledTimes(1)
		expect(io.store).toHaveBeenCalledTimes(2)
	})

	it('recovers a Mux success after a database failure without adding another ID', async () => {
		const io = makeIO()
		io.store.mockRejectedValueOnce(new Error('database offline'))
		await expect(provisionC5SignedPlayback([row], io)).rejects.toThrow(
			'database offline',
		)
		io.getSignedIds.mockResolvedValue(['signed-fixture'])
		await provisionC5SignedPlayback([row], io)
		expect(io.createSignedId).toHaveBeenCalledTimes(1)
	})

	it('does not write if the pre-Mux snapshot fails', async () => {
		const io = makeIO()
		io.snapshot.mockImplementation(() => {
			throw new Error('disk full')
		})
		await expect(provisionC5SignedPlayback([row], io)).rejects.toThrow(
			'disk full',
		)
		expect(io.createSignedId).not.toHaveBeenCalled()
		expect(io.store).not.toHaveBeenCalled()
	})
})
