/**
 * One-time backfill: image metadata (width/height/bytes/format) for
 * `imageResource` rows that predate the media-bindings fix that stores
 * Cloudinary metadata on upload.
 *
 * Approach: BULK-list the Cloudinary account's images via the Admin API
 * (`api.resources`, 500 per page, cursor-paged — NOT per-row Admin calls,
 * which would burn the rate limit), build an asset_id → metadata map, then
 * JSON_SET the four fields onto every `imageResource` row that is missing
 * `$.width`. Rows whose id (= Cloudinary asset_id, see createImageResource)
 * is not in the map are logged as misses and left untouched.
 *
 * Usage (from apps/ai-hero, env comes from .env via dotenv):
 *
 *   pnpm tsx -r dotenv/config src/scripts/backfill-image-metadata.ts --dry-run
 *   pnpm tsx -r dotenv/config src/scripts/backfill-image-metadata.ts
 *
 * --dry-run lists what WOULD be updated without touching the database.
 *
 * Requires CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET /
 * NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME (already in env.mjs). Safe to re-run:
 * the WHERE clause only matches rows still missing `$.width`.
 */
import { db } from '@/db'
import { contentResource } from '@/db/schema'
import { cloudinary } from '@/utils/cloudinary'
import { and, eq, sql } from 'drizzle-orm'

interface ImageMetadata {
	width: number
	height: number
	bytes: number
	format: string
}

interface CloudinaryResource {
	asset_id?: string
	public_id: string
	width?: number
	height?: number
	bytes?: number
	format?: string
}

interface CloudinaryResourcesPage {
	resources: CloudinaryResource[]
	next_cursor?: string
}

const isDryRun = process.argv.includes('--dry-run')

/**
 * Page the WHOLE image library into an asset_id → metadata map. One Admin
 * API call per 500 assets keeps us far from the rate limit even on large
 * accounts.
 */
async function buildCloudinaryMetadataMap(): Promise<
	Map<string, ImageMetadata>
> {
	const map = new Map<string, ImageMetadata>()
	let nextCursor: string | undefined
	let page = 0

	do {
		const result: CloudinaryResourcesPage = await cloudinary.api.resources({
			resource_type: 'image',
			max_results: 500,
			...(nextCursor ? { next_cursor: nextCursor } : {}),
		})
		page += 1
		for (const resource of result.resources) {
			if (
				resource.asset_id &&
				resource.width != null &&
				resource.height != null &&
				resource.bytes != null &&
				resource.format != null
			) {
				map.set(resource.asset_id, {
					width: resource.width,
					height: resource.height,
					bytes: resource.bytes,
					format: resource.format,
				})
			}
		}
		nextCursor = result.next_cursor
		console.log(
			`cloudinary page ${page}: ${result.resources.length} assets (map size ${map.size})`,
		)
	} while (nextCursor)

	return map
}

async function backfill() {
	console.log(
		`Backfilling imageResource metadata${isDryRun ? ' (DRY RUN — no writes)' : ''}…`,
	)

	const metadataByAssetId = await buildCloudinaryMetadataMap()
	console.log(`Cloudinary map ready: ${metadataByAssetId.size} image assets`)

	// Every imageResource row still missing intrinsic metadata. The row id IS
	// the Cloudinary asset_id (createImageResource inserts it that way).
	const rows = await db
		.select({ id: contentResource.id })
		.from(contentResource)
		.where(
			and(
				eq(contentResource.type, 'imageResource'),
				sql`JSON_EXTRACT(${contentResource.fields}, '$.width') IS NULL`,
			),
		)
	console.log(`${rows.length} imageResource rows missing $.width`)

	let hits = 0
	let misses = 0
	let skips = 0

	for (const row of rows) {
		const metadata = metadataByAssetId.get(row.id)
		if (!metadata) {
			misses += 1
			console.log(`MISS  ${row.id} — not found in Cloudinary listing`)
			continue
		}
		if (isDryRun) {
			skips += 1
			console.log(
				`SKIP  ${row.id} (dry run) — would set ${metadata.width}x${metadata.height}, ${metadata.bytes} bytes, ${metadata.format}`,
			)
			continue
		}
		await db
			.update(contentResource)
			.set({
				fields: sql`JSON_SET(${contentResource.fields},
					'$.width', ${metadata.width},
					'$.height', ${metadata.height},
					'$.bytes', ${metadata.bytes},
					'$.format', ${metadata.format})`,
			})
			.where(eq(contentResource.id, row.id))
		hits += 1
		console.log(
			`HIT   ${row.id} — set ${metadata.width}x${metadata.height}, ${metadata.bytes} bytes, ${metadata.format}`,
		)
	}

	console.log(
		`Done. hits=${hits} misses=${misses} skips=${skips} (of ${rows.length} candidate rows)`,
	)
}

await backfill()
process.exit(0)
