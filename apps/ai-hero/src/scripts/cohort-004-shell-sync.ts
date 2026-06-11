import { readFile, writeFile } from 'node:fs/promises'
import { contentResource, contentResourceResource } from '@/db/schema'
import { db } from '@/db'
import { guid } from '@coursebuilder/utils/guid'
import { and, eq } from 'drizzle-orm'
import { Console, Effect } from 'effect'

type Manifest = {
	summary: {
		targetCohortId: string
		workshopCount: number
		lessonCount: number
		totalActions: number
	}
	actions: Action[]
}

type CreateAction = {
	op: 'createResource'
	dryRun: true
	clientKey: string
	type: string
	title: string
	fields: Record<string, unknown>
	sourcePath: string
}

type RelationAction = {
	op: 'upsertRelation'
	dryRun: true
	parentId?: string
	parentClientKey?: string
	childClientKey: string
	resourceOfId?: string
	position: number
	metadata?: Record<string, unknown>
}

type Action = CreateAction | RelationAction

type CreatedResource = {
	clientKey: string
	id: string
	type: string
	title: string
	slug: string
}

type Receipt = {
	mode: 'dry-run' | 'apply'
	generatedAt: string
	manifestPath: string
	targetCohortId: string
	createdResources: CreatedResource[]
	relations: Array<{
		resourceOfId: string
		resourceId: string
		position: number
		metadata?: Record<string, unknown>
		action: 'would-upsert' | 'created' | 'updated'
	}>
}

const defaultManifestPath =
	'/Users/joel/Code/badass-courses/aihero-support/docs/cohort-004/ops/cohort-004-shell-sync-dry-run-2026-05-15.json'

const program = Effect.gen(function* () {
	const args = parseArgs(process.argv.slice(2))
	const mode = args.apply ? 'apply' : 'dry-run'
	const manifestPath = args.manifest ?? defaultManifestPath
	const manifest = yield* readManifest(manifestPath)

	if (mode === 'apply') {
		if (args.confirm !== manifest.summary.targetCohortId) {
			return yield* Effect.fail(
				new Error(
					`Apply requires --confirm ${manifest.summary.targetCohortId}`,
				),
			)
		}
		if (!args.createdById) {
			return yield* Effect.fail(new Error('Apply requires --created-by-id'))
		}
	}

	yield* Console.log(
		`${mode}: ${manifest.summary.workshopCount} workshops, ${manifest.summary.lessonCount} lessons, ${manifest.summary.totalActions} planned actions`,
	)

	const receipt =
		mode === 'apply'
			? yield* applyManifest(manifest, manifestPath, args.createdById as string)
			: yield* dryRunManifest(manifest, manifestPath)

	const receiptPath =
		args.receipt ??
		`/Users/joel/Code/badass-courses/aihero-support/docs/cohort-004/ops/cohort-004-shell-sync-${mode}-receipt-${new Date().toISOString().replace(/[:.]/g, '-')}.json`

	yield* Effect.promise(() =>
		writeFile(receiptPath, JSON.stringify(receipt, null, 2)),
	)
	yield* Console.log(`receipt: ${receiptPath}`)
	yield* Console.log(JSON.stringify(summarizeReceipt(receipt), null, 2))
})

function parseArgs(args: string[]) {
	const result: Record<string, string | boolean> = {}
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (arg === '--apply') result.apply = true
		else if (arg === '--manifest')
			result.manifest = readRequiredValue(args, ++i, arg)
		else if (arg === '--created-by-id')
			result.createdById = readRequiredValue(args, ++i, arg)
		else if (arg === '--confirm')
			result.confirm = readRequiredValue(args, ++i, arg)
		else if (arg === '--receipt')
			result.receipt = readRequiredValue(args, ++i, arg)
		else if (arg === '--help') {
			printHelp()
			process.exit(0)
		}
	}
	return result as {
		apply?: boolean
		manifest?: string
		createdById?: string
		confirm?: string
		receipt?: string
	}
}

function readRequiredValue(args: string[], index: number, flag: string) {
	const value = args[index]
	if (!value) throw new Error(`${flag} requires a value`)
	return value
}

function printHelp() {
	console.log(`Usage:
  bun src/scripts/cohort-004-shell-sync.ts [--manifest path] [--receipt path]
  bun src/scripts/cohort-004-shell-sync.ts --apply --confirm cohort-m0k0w --created-by-id <user-id>

Default mode is dry-run. Apply creates resources and upserts contentResourceResource relations.`)
}

function readManifest(path: string) {
	return Effect.promise(
		async () => JSON.parse(await readFile(path, 'utf8')) as Manifest,
	)
}

function dryRunManifest(manifest: Manifest, manifestPath: string) {
	return Effect.sync(() => {
		const createdResources: CreatedResource[] = []
		const ids = new Map<string, string>()
		const relations: Receipt['relations'] = []

		for (const action of manifest.actions) {
			if (action.op === 'createResource') {
				const shortId = guid()
				const id = `${action.type}-${shortId}`
				const slug = withGeneratedShortId(
					String(action.fields.slugBase ?? action.fields.slug),
					shortId,
				)
				ids.set(action.clientKey, id)
				createdResources.push({
					clientKey: action.clientKey,
					id,
					type: action.type,
					title: action.title,
					slug,
				})
			} else {
				const resourceOfId =
					action.parentId ?? ids.get(action.parentClientKey ?? '')
				const resourceId = ids.get(action.childClientKey)
				if (!resourceOfId || !resourceId)
					throw new Error(`Unresolved relation ${JSON.stringify(action)}`)
				relations.push({
					resourceOfId,
					resourceId,
					position: action.position,
					metadata: action.metadata,
					action: 'would-upsert',
				})
			}
		}

		return {
			mode: 'dry-run' as const,
			generatedAt: new Date().toISOString(),
			manifestPath,
			targetCohortId: manifest.summary.targetCohortId,
			createdResources,
			relations,
		}
	})
}

function applyManifest(
	manifest: Manifest,
	manifestPath: string,
	createdById: string,
) {
	return Effect.promise(async () => {
		const createdResources: CreatedResource[] = []
		const ids = new Map<string, string>()
		const relations: Receipt['relations'] = []

		await db.transaction(async (tx) => {
			const cohort = await tx.query.contentResource.findFirst({
				where: eq(contentResource.id, manifest.summary.targetCohortId),
			})
			if (!cohort)
				throw new Error(
					`Target cohort not found: ${manifest.summary.targetCohortId}`,
				)

			for (const action of manifest.actions) {
				if (action.op !== 'createResource') continue
				const shortId = guid()
				const id = `${action.type}-${shortId}`
				const slugSource = action.fields.slugBase ?? action.fields.slug
				if (!slugSource || typeof slugSource !== 'string') {
					throw new Error(
						`createResource missing slug source for ${action.clientKey}`,
					)
				}
				const slug = withGeneratedShortId(slugSource, shortId)
				const fields = {
					...action.fields,
					slug,
					slugBase: slugSource,
					slugShortId: shortId,
				}
				await tx.insert(contentResource).values({
					id,
					type: action.type,
					fields,
					createdById,
				})
				ids.set(action.clientKey, id)
				createdResources.push({
					clientKey: action.clientKey,
					id,
					type: action.type,
					title: action.title,
					slug,
				})
			}

			for (const action of manifest.actions) {
				if (action.op !== 'upsertRelation') continue
				const resourceOfId =
					action.parentId ?? ids.get(action.parentClientKey ?? '')
				const resourceId = ids.get(action.childClientKey)
				if (!resourceOfId || !resourceId)
					throw new Error(`Unresolved relation ${JSON.stringify(action)}`)

				const existing = await tx.query.contentResourceResource.findFirst({
					where: and(
						eq(contentResourceResource.resourceOfId, resourceOfId),
						eq(contentResourceResource.resourceId, resourceId),
					),
				})

				if (existing) {
					await tx
						.update(contentResourceResource)
						.set({
							position: action.position,
							...(action.metadata !== undefined
								? { metadata: action.metadata }
								: {}),
							updatedAt: new Date(),
							deletedAt: null,
						})
						.where(
							and(
								eq(contentResourceResource.resourceOfId, resourceOfId),
								eq(contentResourceResource.resourceId, resourceId),
							),
						)
					relations.push({
						resourceOfId,
						resourceId,
						position: action.position,
						metadata: action.metadata,
						action: 'updated',
					})
				} else {
					await tx.insert(contentResourceResource).values({
						resourceOfId,
						resourceId,
						position: action.position,
						metadata: action.metadata,
					})
					relations.push({
						resourceOfId,
						resourceId,
						position: action.position,
						metadata: action.metadata,
						action: 'created',
					})
				}
			}
		})

		return {
			mode: 'apply' as const,
			generatedAt: new Date().toISOString(),
			manifestPath,
			targetCohortId: manifest.summary.targetCohortId,
			createdResources,
			relations,
		}
	})
}

function withGeneratedShortId(base: string, shortId: string) {
	return `${base.replace(/~[a-z0-9]+$/i, '')}~${shortId}`
}

function summarizeReceipt(receipt: Receipt) {
	return {
		mode: receipt.mode,
		targetCohortId: receipt.targetCohortId,
		createdResources: receipt.createdResources.length,
		relations: receipt.relations.length,
		writesPerformed: receipt.mode === 'apply',
	}
}

Effect.runPromise(program).catch((error) => {
	console.error(error instanceof Error ? error.message : error)
	process.exit(1)
})
