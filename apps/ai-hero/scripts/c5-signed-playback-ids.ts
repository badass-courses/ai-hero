import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { contentResource } from '../src/db/schema'
import {
	c5SignedPlaybackInventoryQuery,
	type C5PlaybackRow,
} from '../src/lib/c5-signed-playback-inventory'
import { provisionC5SignedPlayback } from '../src/lib/c5-signed-playback-assets'

async function main() {
	const args = process.argv.slice(2)
	if (args.includes('--help')) {
		console.log(
			'Usage: pnpm exec tsx scripts/c5-signed-playback-ids.ts [--allow-write] [--snapshot /private/path.jsonl]',
		)
		return
	}
	const allowWrite = args.includes('--allow-write')
	let snapshotPath = join(
		homedir(),
		'.cache',
		'aih-signed-playback',
		`${Date.now()}.jsonl`,
	)
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--allow-write') continue
		if (args[i] === '--snapshot' && args[i + 1])
			snapshotPath = resolve(args[++i]!)
		else throw new Error('Unknown or incomplete argument; use --help')
	}
	if (!process.env.DATABASE_URL)
		throw new Error(
			'DATABASE_URL is required (read-only access is enough for dry run)',
		)
	const { db, closeDatabasePool } = await import('../src/db/client')
	let journal: number | undefined
	try {
		const result = await db.execute(c5SignedPlaybackInventoryQuery())
		const rows = [
			...new Map(
				(result.rows as C5PlaybackRow[]).map((row) => [row.resourceId, row]),
			).values(),
		]
		for (const row of rows) {
			console.log(
				JSON.stringify({
					resourceId: row.resourceId,
					assetId: row.assetId,
					hasSignedPlaybackId: Boolean(row.signedPlaybackId),
				}),
			)
		}
		console.log(
			JSON.stringify({
				dryRun: !allowWrite,
				videos: rows.length,
				assets: new Set(rows.map((r) => r.assetId).filter(Boolean)).size,
				alreadySigned: rows.filter((r) => r.signedPlaybackId).length,
				missingAsset: rows.filter((r) => !r.assetId).length,
			}),
		)
		if (!allowWrite) return // No Mux client, snapshot, or writes on this path.
		if (!process.env.MUX_ACCESS_TOKEN_ID || !process.env.MUX_SECRET_KEY)
			throw new Error('Mux API credentials are required for --allow-write')
		if (rows.some((r) => !r.assetId || !r.publicPlaybackId))
			throw new Error('Inventory has incomplete assets; refusing writes')
		mkdirSync(dirname(snapshotPath), { recursive: true, mode: 0o700 })
		journal = openSync(snapshotPath, 'wx', 0o600)
		console.log(`Snapshot: ${snapshotPath}`)
		const authorization = `Basic ${Buffer.from(`${process.env.MUX_ACCESS_TOKEN_ID}:${process.env.MUX_SECRET_KEY}`).toString('base64')}`
		const request = async (assetId: string, create = false) => {
			const response = await fetch(
				`https://api.mux.com/video/v1/assets/${encodeURIComponent(assetId)}${create ? '/playback-ids' : ''}`,
				{
					method: create ? 'POST' : 'GET',
					headers: {
						Authorization: authorization,
						'Content-Type': 'application/json',
					},
					...(create ? { body: JSON.stringify({ policy: 'signed' }) } : {}),
					signal: AbortSignal.timeout(30_000),
				},
			)
			// Do not print Mux response bodies or request credentials on failure.
			if (!response.ok)
				throw new Error(
					`Mux ${create ? 'create' : 'read'} failed: HTTP ${response.status}`,
				)
			return response.json() as Promise<{
				data: { id?: string; playback_ids?: { id: string; policy: string }[] }
			}>
		}
		const counts = await provisionC5SignedPlayback(rows, {
			getSignedIds: async (assetId) =>
				(await request(assetId)).data.playback_ids
					?.filter((p) => p.policy === 'signed')
					.map((p) => p.id) ?? [],
			createSignedId: async (assetId) => {
				const id = (await request(assetId, true)).data.id
				if (!id)
					throw new Error(
						'Mux create response missing playback ID; rerun to recover from Mux',
					)
				return id
			},
			snapshot: (entry) => {
				writeSync(journal!, `${JSON.stringify(entry)}\n`)
				fsyncSync(journal!) // Durable intent before Mux; durable signed ID before DB.
			},
			store: async (resourceId, assetId, signedId) => {
				await db
					.update(contentResource)
					.set({
						fields: sql`JSON_SET(${contentResource.fields}, '$.muxSignedPlaybackId', ${signedId})`,
					})
					.where(
						and(
							eq(contentResource.id, resourceId),
							eq(contentResource.type, 'videoResource'),
							isNull(contentResource.deletedAt),
							sql`${contentResource.fields}->>'$.muxAssetId' = ${assetId}`,
							sql`COALESCE(${contentResource.fields}->>'$.muxSignedPlaybackId', '') = ''`,
						),
					)
				const stored = await db
					.select({ fields: contentResource.fields })
					.from(contentResource)
					.where(eq(contentResource.id, resourceId))
				if (stored[0]?.fields?.muxSignedPlaybackId !== signedId)
					throw new Error(
						'Signed ID readback failed; stop and inspect snapshot',
					)
			},
		})
		console.log(JSON.stringify(counts))
	} finally {
		if (journal !== undefined) closeSync(journal)
		await closeDatabasePool()
	}
}

main().catch(() => {
	// DB errors may contain connection strings. Keep failures credential-free.
	console.error(
		'C5 signed playback command failed. Check required env, database access, and any private snapshot. No public playback IDs were changed.',
	)
	process.exitCode = 1
})
