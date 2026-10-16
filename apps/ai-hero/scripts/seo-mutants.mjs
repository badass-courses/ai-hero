import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const app = fileURLToPath(new URL('..', import.meta.url))
/** @type {{ name: string, file: string, test: string, replacements: [string, string][] }[]} */
const mutants = [
	{
		name: 'markdown not stripped',
		file: 'src/lib/meta-description.ts',
		test: 'src/lib/meta-description.test.ts',
		replacements: [['plainDescription(source)', "(source ?? '')"]],
	},
	{
		name: 'cut mid-word',
		file: 'src/lib/meta-description.ts',
		test: 'src/lib/meta-description.test.ts',
		replacements: [['candidate.slice(0, boundary)', 'candidate']],
	},
	{
		name: 'hard-coded offer price',
		file: 'src/lib/course-schema.ts',
		test: 'src/lib/course-schema.test.ts',
		replacements: [['price: amount,', 'price: 247,']],
	},
	{
		name: 'unknown price emitted as zero',
		file: 'src/lib/course-schema.ts',
		test: 'src/lib/course-schema.test.ts',
		replacements: [
			[
				'const amount = product?.price?.unitAmount',
				'const amount = product?.price?.unitAmount ?? 0',
			],
			['amount <= 0', 'amount < 0'],
		],
	},
	{
		name: 'sold out emitted as InStock',
		file: 'src/lib/course-schema.ts',
		test: 'src/lib/course-schema.test.ts',
		replacements: [['quantityAvailable === 0', 'false']],
	},
	{
		name: 'homepage canonical missing',
		file: 'src/app/page.tsx',
		test: 'src/app/homepage-seo.test.tsx',
		replacements: [
			[
				"alternates: { canonical: new URL('/', config.siteUrl).href },",
				'alternates: {},',
			],
		],
	},
	{
		name: 'legacy empty price fields lose offers',
		file: 'src/lib/course-schema.ts',
		test: 'src/lib/course-schema.test.ts',
		replacements: [
			[
				'const amount = product?.price?.unitAmount',
				'const amount = product?.price?.unitAmount\n\tif (!product?.price?.fields?.stripe) return undefined',
			],
		],
	},
	{
		name: 'pre-open enrollment emitted InStock',
		file: 'src/lib/course-schema.ts',
		test: 'src/lib/course-schema.test.ts',
		replacements: [['new Date(availabilityStarts) > now', 'false']],
	},
	{
		name: 'unknown inventory hides Product JSON-LD',
		file: 'src/app/(content)/cohorts/[slug]/page.tsx',
		test: 'src/lib/seo-head.test.tsx',
		replacements: [
			['{product ? (', '{product && quantityAvailable !== undefined ? ('],
		],
	},
	{
		name: 'draft enters sitemap',
		file: 'src/lib/public-content-index.ts',
		test: 'src/app/sitemap.test.ts',
		replacements: [
			[
				"if (item.state !== 'published' || item.visibility !== 'public') return",
				'/* mutant: publication gate removed */',
			],
		],
	},
]

// Run with no other writer/checker in this checkout: each plant is restored in finally.
let escaped = false
for (const mutant of mutants) {
	const path = `${app}/${mutant.file}`
	const original = readFileSync(path, 'utf8')
	let planted = original
	for (const [from, to] of mutant.replacements) {
		if (planted.split(from).length !== 2)
			throw new Error(`Plant must match once: ${mutant.name}: ${from}`)
		planted = planted.replace(from, to)
	}
	try {
		writeFileSync(path, planted)
		const run = spawnSync('pnpm', ['exec', 'vitest', 'run', mutant.test], {
			cwd: app,
			encoding: 'utf8',
			timeout: 30000,
		})
		const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
		const caught = run.status === 1 && output.includes('AssertionError')
		console.log(`${caught ? 'KILLED' : 'ESCAPED'}: ${mutant.name}`)
		if (!caught) {
			escaped = true
			console.log(output)
		}
	} finally {
		writeFileSync(path, original)
	}
}
if (escaped) process.exitCode = 1
