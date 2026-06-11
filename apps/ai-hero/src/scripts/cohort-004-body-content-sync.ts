import { readFile, writeFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { db } from '@/db'
import { contentResource } from '@/db/schema'
import { log } from '@/server/logger'
import { eq } from 'drizzle-orm'
import { Effect } from 'effect'

type BodyAction = {
	op: 'updateLessonBodyFromSource'
	lessonId: string
	lessonClientKey: string
	sourcePath: string
	bodySourcePath: string | null
	todoStub: boolean
	fieldUpdates: Record<string, unknown>
	commitMapCandidateStatus: string
}

type Manifest = {
	summary: { targetCohortId: string; lessonCount: number; actions: number }
	actions: BodyAction[]
}

const defaultManifestPath =
	'/Users/joel/Code/badass-courses/aihero-support/docs/cohort-004/ops/cohort-004-body-content-dry-run-2026-05-15.json'
const dropboxRoot =
	'/Users/joel/egghead.io Dropbox/_egghead-team/02 areas/AI Hero/Courses/Claude Code Cohort (Cohort 004)'

const program = Effect.gen(function* () {
	const args = parseArgs(process.argv.slice(2))
	const mode = args.apply ? 'apply' : 'dry-run'
	const manifestPath = args.manifest ?? defaultManifestPath
	const manifest = yield* Effect.promise(
		async () => JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest,
	)

	if (mode === 'apply') {
		if (args.confirm !== manifest.summary.targetCohortId) {
			throw new Error(
				`Apply requires --confirm ${manifest.summary.targetCohortId}`,
			)
		}
	}

	yield* Effect.promise(() =>
		log.info('cohort-004.body-content-sync.started', {
			mode,
			manifestPath,
			lessonCount: manifest.summary.lessonCount,
			actions: manifest.summary.actions,
		}),
	)

	const receipt = yield* Effect.promise(() =>
		syncBodyContent({ manifest, manifestPath, mode }),
	)
	const receiptPath =
		args.receipt ??
		`/Users/joel/Code/badass-courses/aihero-support/docs/cohort-004/ops/cohort-004-body-content-${mode}-receipt-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
	yield* Effect.promise(() =>
		writeFile(receiptPath, JSON.stringify(receipt, null, 2)),
	)
	yield* Effect.promise(() =>
		log.info('cohort-004.body-content-sync.completed', {
			mode,
			manifestPath,
			receiptPath,
			lessonCount: manifest.summary.lessonCount,
			actions: manifest.summary.actions,
			summary: summarize(receipt),
		}),
	)
})

/**
 * Parse command-line flags for the Cohort 004 body sync script.
 *
 * @param args - Raw process arguments after the script name.
 * @returns Parsed flags for dry-run or apply execution.
 */
function parseArgs(args: string[]) {
	const out: Record<string, string | boolean> = {}
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (arg === '--apply') out.apply = true
		else if (arg === '--manifest') out.manifest = required(args, ++i, arg)
		else if (arg === '--receipt') out.receipt = required(args, ++i, arg)
		else if (arg === '--confirm') out.confirm = required(args, ++i, arg)
	}
	return out as {
		apply?: boolean
		manifest?: string
		receipt?: string
		confirm?: string
	}
}

/**
 * Read a required flag value from a positional argument list.
 *
 * @param args - Raw argument list.
 * @param index - Index expected to contain the flag value.
 * @param flag - Flag name used in the error message.
 * @returns The non-empty flag value.
 * @throws When the value is missing.
 */
function required(args: string[], index: number, flag: string) {
	const value = args[index]
	if (!value) throw new Error(`${flag} requires a value`)
	return value
}

/**
 * Build or apply body updates from a Cohort 004 body manifest.
 *
 * @param options - Manifest, manifest path, and execution mode.
 * @returns A receipt describing planned or applied lesson body updates.
 */
async function syncBodyContent(options: {
	manifest: Manifest
	manifestPath: string
	mode: 'dry-run' | 'apply'
}) {
	const updates: Array<{
		lessonId: string
		bodySourcePath: string | null
		contentSyncStatus: string
		commitMapCandidateStatus: string
		action:
			| 'would-update'
			| 'updated'
			| 'missing-lesson'
			| 'missing-body-source'
	}> = []

	for (const action of options.manifest.actions) {
		const lesson = await db.query.contentResource.findFirst({
			where: eq(contentResource.id, action.lessonId),
		})
		if (!lesson) {
			updates.push({
				lessonId: action.lessonId,
				bodySourcePath: action.bodySourcePath,
				contentSyncStatus: 'missing-lesson',
				commitMapCandidateStatus: action.commitMapCandidateStatus,
				action: 'missing-lesson',
			})
			continue
		}
		if (!action.bodySourcePath) {
			updates.push({
				lessonId: action.lessonId,
				bodySourcePath: null,
				contentSyncStatus: 'needs-body-source-review',
				commitMapCandidateStatus: action.commitMapCandidateStatus,
				action: 'missing-body-source',
			})
			continue
		}

		const sourceBody = await readFile(
			resolveManifestPath(dropboxRoot, action.bodySourcePath),
			'utf8',
		)
		const body = buildBody({ sourceBody, action })
		const contentSyncStatus = action.todoStub
			? 'todo-stub'
			: 'source-markdown-applied'

		if (options.mode === 'apply') {
			await db
				.update(contentResource)
				.set({
					fields: {
						...(lesson.fields as Record<string, unknown>),
						...action.fieldUpdates,
						body,
						bodySourcePath: action.bodySourcePath,
						sourcePath: action.sourcePath,
						contentSyncStatus,
						commitMapCandidateStatus: action.commitMapCandidateStatus,
					},
				})
				.where(eq(contentResource.id, action.lessonId))
		}

		updates.push({
			lessonId: action.lessonId,
			bodySourcePath: action.bodySourcePath,
			contentSyncStatus,
			commitMapCandidateStatus: action.commitMapCandidateStatus,
			action: options.mode === 'apply' ? 'updated' : 'would-update',
		})
	}

	return {
		mode: options.mode,
		generatedAt: new Date().toISOString(),
		manifestPath: options.manifestPath,
		targetCohortId: options.manifest.summary.targetCohortId,
		writesPerformed: options.mode === 'apply',
		updates,
	}
}

/**
 * Wrap source markdown with sync metadata comments for a lesson body.
 *
 * @param sourceBody - Markdown read from the source file.
 * @param action - Manifest action that supplies source and status metadata.
 * @returns The final body written to the lesson resource.
 */
function buildBody({
	sourceBody,
	action,
}: {
	sourceBody: string
	action: BodyAction
}) {
	const trimmed = sourceBody.trim()
	const parts = [
		'<!-- cohort-004-source-grounded -->',
		`<!-- sourcePath: ${action.bodySourcePath} -->`,
		`<!-- contentSyncStatus: ${action.todoStub ? 'todo-stub' : 'source-markdown-applied'} -->`,
		`<!-- commitMapCandidateStatus: ${action.commitMapCandidateStatus} -->`,
		'',
		trimmed || 'TODO: lesson content stub for Cohort 004.',
	]
	return parts.join('\n')
}

/**
 * Reduce a body sync receipt to operator-facing counts.
 *
 * @param receipt - Full sync receipt returned by syncBodyContent.
 * @returns Summary counts for logging and review.
 */
function summarize(receipt: Awaited<ReturnType<typeof syncBodyContent>>) {
	return {
		mode: receipt.mode,
		targetCohortId: receipt.targetCohortId,
		updates: receipt.updates.length,
		updated: receipt.updates.filter((update) => update.action === 'updated')
			.length,
		wouldUpdate: receipt.updates.filter(
			(update) => update.action === 'would-update',
		).length,
		missingLesson: receipt.updates.filter(
			(update) => update.action === 'missing-lesson',
		).length,
		missingBodySource: receipt.updates.filter(
			(update) => update.action === 'missing-body-source',
		).length,
		writesPerformed: receipt.writesPerformed,
	}
}

function resolveManifestPath(rootPath: string, relativePath: string) {
	const root = resolve(rootPath)
	const filePath = resolve(root, relativePath)
	if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
		throw new Error(`Invalid bodySourcePath: ${relativePath}`)
	}
	return filePath
}

Effect.runPromise(program).catch(async (error) => {
	await log.error('cohort-004.body-content-sync.failed', {
		error: error instanceof Error ? error.message : String(error),
	})
	process.exit(1)
})
