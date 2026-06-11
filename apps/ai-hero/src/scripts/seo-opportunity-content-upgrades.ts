import { courseBuilderAdapter, db } from '@/db'
import { contentResource } from '@/db/schema'
import { log, serializeError } from '@/server/logger'
import { sql } from 'drizzle-orm'

type Upgrade = {
	slug: string
	title: string
	insertAfter: string
	section: string
}

const upgrades: Upgrade[] = [
	{
		slug: 'what-is-the-ai-sdk',
		title: "What Is Vercel's AI SDK?",
		insertAfter: `There's also an AI SDK RSC framework, for building with React Server Components.`,
		section: `
## What Can You Build With The AI SDK?

The AI SDK is useful when your app needs to talk to an LLM and do something more structured than one plain text response.

The common building blocks are:

- streaming text back to the UI
- asking for structured outputs
- calling tools from the model
- switching between model providers without rewriting the whole app
- building agent-style flows where the model can take more than one step

That means the AI SDK is a good fit for chat interfaces, coding tools, workflow assistants, document tools, and internal agents.

If you want to go past the overview, the [AI SDK v6 Crash Course](/workshops/ai-sdk-v6-crash-course) walks through these pieces in a working app.
`,
	},
	{
		slug: 'creating-the-perfect-claude-code-status-line',
		title: 'Creating The Perfect Claude Code Status Line',
		insertAfter: `Having this constantly at my fingertips and monitoring it going, "Ooh, I think about 60 is probably where I want to stop" is just amazing.`,
		section: `
## What Should A Claude Code Status Line Show?

A useful Claude Code status line should show the facts you need before you decide what to do next.

For me, that means:

- which repo I'm in
- which Git branch I'm on
- whether I have staged or unstaged changes
- how much of the context window this session has used

The repo and Git state help me avoid working in the wrong place. The context percentage helps me decide when to keep going, compact, or hand off to a fresh session.

The exact format matters less than having the important signals visible without asking Claude Code to spend another turn checking them.
`,
	},
]

const args = new Set(process.argv.slice(2))
const apply = args.has('--apply')

/**
 * Inserts an approved SEO content section after a known source anchor.
 *
 * @param body - The current content-resource body markdown.
 * @param upgrade - The upgrade definition, including slug, anchor, and section.
 * @returns The next body plus a reason: `already-present` when the section is already in the body, `anchor-not-found` when the anchor is missing, or `changed` when insertion succeeded.
 *
 * @example
 * ```ts
 * const next = insertSection(resource.fields.body, upgrade)
 * if (next.changed) await updateBody(next.body)
 * ```
 */
function insertSection(body: string, upgrade: Upgrade) {
	if (body.includes(upgrade.section.trim())) {
		return { body, changed: false, reason: 'already-present' as const }
	}

	if (!body.includes(upgrade.insertAfter)) {
		return { body, changed: false, reason: 'anchor-not-found' as const }
	}

	return {
		body: body.replace(
			upgrade.insertAfter,
			`${upgrade.insertAfter}\n${upgrade.section}`,
		),
		changed: true,
		reason: 'changed' as const,
	}
}

/**
 * Dry-runs or applies the approved Ahrefs opportunity content upgrades.
 *
 * Reads matching content resources by slug, inserts source-approved sections after known anchors, and logs structured results. Passing `--apply` writes the updated bodies.
 *
 * @returns A promise that resolves after all configured upgrades are checked.
 *
 * @example
 * ```bash
 * pnpm tsx src/scripts/seo-opportunity-content-upgrades.ts
 * pnpm tsx src/scripts/seo-opportunity-content-upgrades.ts --apply
 * ```
 */
async function main() {
	const results = []

	for (const upgrade of upgrades) {
		const resource = await db.query.contentResource.findFirst({
			where: sql`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.slug')) = ${upgrade.slug}`,
		})

		if (!resource) {
			results.push({ slug: upgrade.slug, status: 'missing-resource' })
			continue
		}

		const body = String(resource.fields?.body ?? '')
		const next = insertSection(body, upgrade)

		if (!next.changed) {
			results.push({
				slug: upgrade.slug,
				id: resource.id,
				status: next.reason,
			})
			continue
		}

		if (apply) {
			await courseBuilderAdapter.updateContentResourceFields({
				id: resource.id,
				fields: {
					...resource.fields,
					body: next.body,
				},
			})
		}

		results.push({
			slug: upgrade.slug,
			id: resource.id,
			status: apply ? 'applied' : 'dry-run',
			beforeLength: body.length,
			afterLength: next.body.length,
			insertedHeading: upgrade.section.match(/^## .+$/m)?.[0] ?? null,
		})
	}

	const mode = apply ? 'apply' : 'dry-run'
	const changedCount = results.filter((result) =>
		['applied', 'dry-run'].includes(result.status),
	).length

	await log.info('seo.opportunity_content_upgrades.completed', {
		mode,
		totalCount: results.length,
		changedCount,
		slugs: results.map((result) => result.slug),
		results,
	})
}

main().catch(async (error) => {
	await log.error('seo.opportunity_content_upgrades.failed', {
		mode: apply ? 'apply' : 'dry-run',
		slugs: upgrades.map((upgrade) => upgrade.slug),
		error: serializeError(error),
	})
	process.exit(1)
})
