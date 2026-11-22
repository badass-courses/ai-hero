import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * sec-050: these server actions checked only `can(x, 'Content')`, which every
 * contributor passes for anyone's content. Each must run the per-record guard
 * (requireContentUpdate, covered by content-edit-guard.test.ts) on the record
 * it writes, before its first write.
 */
const ACTIONS: Array<[file: string, fn: string, ids: string]> = [
	['lessons-query.ts', 'updateLesson', '[input.id]'],
	['solutions-query.ts', 'createSolution', '[lessonId]'],
	['solutions-query.ts', 'updateSolution', '[input.id]'],
	['solutions-query.ts', 'deleteSolution', '[solutionId]'],
	['prompts-query.ts', 'updatePrompt', '[input.id]'],
	['pages-query.ts', 'updatePage', '[input.id]'],
	['resources-query.ts', 'updateResource', '[input.id]'],
	['surveys-query.ts', 'updateSurvey', '[input.id]'],
	['surveys-query.ts', 'updateQuestion', '[input.id]'],
	['surveys-query.ts', 'addQuestionToSurvey', '[input.surveyId]'],
	['surveys-query.ts', 'removeQuestionFromSurvey', '[input.surveyId]'],
	['surveys-query.ts', 'updateQuestionPositions', '[input.surveyId]'],
	['video-resource-query.ts', 'attachVideoResourceToPost', '[postId]'],
	['video-resource-query.ts', 'renameVideoResource', '[videoResourceId]'],
]

const WRITE =
	/\b(db|trx|tx)\s*\.\s*(insert|update|delete|transaction)\b|courseBuilderAdapter\.(update|create|delete)\w*\(|upsertPostToTypeSense|revalidateTag\(/

function body(file: string, fn: string): string {
	const source = readFileSync(join(__dirname, file), 'utf8')
	const start = source.indexOf(`export async function ${fn}(`)
	expect(start, `${fn} in ${file}`).toBeGreaterThanOrEqual(0)
	const next = source.indexOf('\nexport ', start + 1)
	return source.slice(start, next === -1 ? undefined : next)
}

describe('content actions check the record, not the type (sec-050)', () => {
	it.each(ACTIONS)('%s %s guards %s before writing', (file, fn, ids) => {
		const text = body(file, fn)
		const guard = text.indexOf(`requireContentUpdate(${ids})`)
		expect(guard, `${fn} calls requireContentUpdate(${ids})`).toBeGreaterThan(0)
		const write = text.search(WRITE)
		if (write !== -1) expect(guard).toBeLessThan(write)
	})
})

const PAGES = [
	'app/(content)/workshops/[module]/[lesson]/edit/page.tsx',
	'app/(content)/workshops/[module]/[lesson]/solution/edit/page.tsx',
	'app/(content)/workshops/[module]/edit/page.tsx',
	'app/admin/pages/[slug]/edit/page.tsx',
	'app/(content)/prompts/[slug]/edit/page.tsx',
	'app/(content)/cohorts/[slug]/edit/page.tsx',
	'app/(content)/events/[slug]/edit/page.tsx',
	'app/admin/emails/[slug]/edit/page.tsx',
]

describe('edit pages open only records the viewer may update (sec-050)', () => {
	it.each(PAGES)('%s checks the record', (page) => {
		const source = readFileSync(join(__dirname, '..', page), 'utf8')
		expect(source).toMatch(
			/ability\.cannot\('update', subject\('Content', \w+\)\)/,
		)
	})
})
