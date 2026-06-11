import fs from 'node:fs'
import { Client } from '@planetscale/database'

const PRODUCT_SLUG = 'ai-hero-catalog-access-zr8ig'

const envText = fs.readFileSync('.env.development', 'utf8')
const match = envText.match(/^DATABASE_URL=(.*)$/m)
if (!match?.[1]) {
	throw new Error('DATABASE_URL not found in .env.development')
}

const databaseUrl = match[1].trim().replace(/^"|"$/g, '')
const client = new Client({ url: databaseUrl })
const conn = client.connection()

const before = await conn.execute(
	`SELECT
		id,
		name,
		type,
		JSON_UNQUOTE(JSON_EXTRACT(fields, '$.slug')) AS slug,
		JSON_EXTRACT(fields, '$.availableAfterDays') AS availableAfterDays,
		JSON_EXTRACT(fields, '$.accessDurationDays') AS accessDurationDays
	 FROM AI_Product
	 WHERE JSON_UNQUOTE(JSON_EXTRACT(fields, '$.slug')) = ?
	 LIMIT 1`,
	[PRODUCT_SLUG],
)

const existing = before.rows?.[0]

if (!existing) {
	throw new Error(`Product not found for slug: ${PRODUCT_SLUG}`)
}

await conn.execute(
	`UPDATE AI_Product
	 SET
		type = ?,
		fields = JSON_SET(
			COALESCE(fields, JSON_OBJECT()),
			'$.availableAfterDays', ?,
			'$.accessDurationDays', ?
		)
	 WHERE id = ?`,
	['cohort-archive', 15, 365, existing.id],
)

const after = await conn.execute(
	`SELECT
		id,
		name,
		type,
		JSON_UNQUOTE(JSON_EXTRACT(fields, '$.slug')) AS slug,
		JSON_EXTRACT(fields, '$.availableAfterDays') AS availableAfterDays,
		JSON_EXTRACT(fields, '$.accessDurationDays') AS accessDurationDays
	 FROM AI_Product
	 WHERE id = ?
	 LIMIT 1`,
	[existing.id],
)

console.log(
	JSON.stringify(
		{
			before: existing,
			after: after.rows?.[0] ?? null,
		},
		null,
		2,
	),
)
