import type { C5PlaybackRow } from './c5-signed-playback-inventory'

export type PlaybackSnapshot = {
	resourceId: string
	assetId: string
	newSignedId: string | null
	phase: 'before_mux' | 'before_database' | 'stored'
}

/** Serial operator-only migration. Recover Mux successes even after a DB failure. */
export async function provisionC5SignedPlayback(
	rows: C5PlaybackRow[],
	io: {
		getSignedIds: (assetId: string) => Promise<string[]>
		createSignedId: (assetId: string) => Promise<string>
		snapshot: (entry: PlaybackSnapshot) => void
		store: (
			resourceId: string,
			assetId: string,
			signedId: string,
		) => Promise<void>
	},
) {
	const byAsset = new Map<string, string>()
	let stored = 0
	for (const row of rows) {
		if (row.signedPlaybackId) continue
		if (!row.assetId || !row.publicPlaybackId)
			throw new Error('Video is missing its Mux asset or public playback ID')
		let signedId = byAsset.get(row.assetId)
		if (!signedId) {
			const existing = await io.getSignedIds(row.assetId)
			// Recover any signed ID already on Mux; never create a second one.
			signedId = existing[0]
			if (!signedId) {
				io.snapshot({
					resourceId: row.resourceId,
					assetId: row.assetId,
					newSignedId: null,
					phase: 'before_mux',
				})
				signedId = await io.createSignedId(row.assetId)
			}
			byAsset.set(row.assetId, signedId)
		}
		io.snapshot({
			resourceId: row.resourceId,
			assetId: row.assetId,
			newSignedId: signedId,
			phase: 'before_database',
		})
		await io.store(row.resourceId, row.assetId, signedId)
		io.snapshot({
			resourceId: row.resourceId,
			assetId: row.assetId,
			newSignedId: signedId,
			phase: 'stored',
		})
		stored++
	}
	return { stored }
}
