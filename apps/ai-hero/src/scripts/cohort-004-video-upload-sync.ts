import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, resolve, sep } from 'node:path'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { db } from '@/db'
import { contentResource } from '@/db/schema'
import { inngest } from '@/inngest/inngest.server'
import { VIDEO_UPLOADED_EVENT } from '@coursebuilder/core/inngest/video-processing/events/event-video-uploaded'
import { eq } from 'drizzle-orm'
import { Console, Effect } from 'effect'

type Action =
	| {
			op: 'uploadVideo'
			parentLessonId: string
			videoSourcePath: string
			target: string
			title: string
			replaceExisting?: boolean
			replaceReason?: string
			videoResourceIdOverride?: string
	  }
	| {
			op: 'updateVideoChapters'
			parentLessonId: string
			videoSourcePath: string
			metaPath: string
			chapterCount: number
			chapters: Array<{ title: string; startTime: number }>
	  }

type Manifest = {
	summary: {
		targetCohortId: string
		currentVideoCount: number
		totalActions: number
	}
	actions: Action[]
}

const manifestPathDefault =
	'/Users/joel/Code/badass-courses/aihero-support/docs/cohort-004/ops/cohort-004-video-chapter-dry-run-2026-05-15.json'
const dropboxRoot =
	'/Users/joel/egghead.io Dropbox/_egghead-team/02 areas/AI Hero/Courses/Claude Code Cohort (Cohort 004)'

const program = Effect.gen(function* () {
	const args = parseArgs(process.argv.slice(2))
	const mode = args.apply ? 'apply' : 'dry-run'
	const manifestPath = args.manifest ?? manifestPathDefault
	const manifest = yield* Effect.promise(
		async () => JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest,
	)
	if (mode === 'apply') {
		if (args.confirm !== manifest.summary.targetCohortId)
			throw new Error(
				`Apply requires --confirm ${manifest.summary.targetCohortId}`,
			)
		if (!args.createdById) throw new Error('Apply requires --created-by-id')
	}
	yield* Console.log(
		`${mode}: ${manifest.summary.currentVideoCount} current videos, ${manifest.summary.totalActions} planned actions`,
	)
	const receipt = yield* Effect.promise(() =>
		sync({
			manifest,
			manifestPath,
			mode,
			createdById: args.createdById,
			includeSolutions: !!args.includeSolutions,
			backfillChapters: !!args.backfillChapters,
			limit: args.limit ? Number(args.limit) : undefined,
		}),
	)
	const receiptPath =
		args.receipt ??
		`/Users/joel/Code/badass-courses/aihero-support/docs/cohort-004/ops/cohort-004-video-upload-${mode}-receipt-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
	yield* Effect.promise(() =>
		writeFile(receiptPath, JSON.stringify(receipt, null, 2)),
	)
	yield* Console.log(`receipt: ${receiptPath}`)
	yield* Console.log(JSON.stringify(summarize(receipt), null, 2))
})

function parseArgs(args: string[]) {
	const out: Record<string, string | boolean> = {}
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === '--apply') out.apply = true
		else if (a === '--backfill-chapters') out.backfillChapters = true
		else if (a === '--include-solutions') out.includeSolutions = true
		else if (a === '--manifest') out.manifest = must(args, ++i, a)
		else if (a === '--receipt') out.receipt = must(args, ++i, a)
		else if (a === '--confirm') out.confirm = must(args, ++i, a)
		else if (a === '--created-by-id') out.createdById = must(args, ++i, a)
		else if (a === '--limit') out.limit = must(args, ++i, a)
	}
	return out as {
		apply?: boolean
		backfillChapters?: boolean
		includeSolutions?: boolean
		manifest?: string
		receipt?: string
		confirm?: string
		createdById?: string
		limit?: string
	}
}
function must(args: string[], i: number, flag: string) {
	const v = args[i]
	if (!v) throw new Error(`${flag} requires a value`)
	return v
}

async function sync(opts: {
	manifest: Manifest
	manifestPath: string
	mode: 'apply' | 'dry-run'
	createdById?: string
	includeSolutions: boolean
	backfillChapters: boolean
	limit?: number
}) {
	const uploadActions = opts.manifest.actions.filter(
		(a): a is Extract<Action, { op: 'uploadVideo' }> => a.op === 'uploadVideo',
	)
	const chapterActions = opts.manifest.actions.filter(
		(a): a is Extract<Action, { op: 'updateVideoChapters' }> =>
			a.op === 'updateVideoChapters',
	)
	const uploads: any[] = []
	const chapters: any[] = []
	const scopedUploadActions = uploadActions.slice(
		0,
		Number.isFinite(opts.limit) ? opts.limit : uploadActions.length,
	)
	const scopedChapterActions = chapterActions.filter((chapter) =>
		scopedUploadActions.some(
			(upload) =>
				upload.parentLessonId === chapter.parentLessonId &&
				upload.videoSourcePath === chapter.videoSourcePath,
		),
	)
	for (const action of scopedUploadActions) {
		const videoResourceId =
			action.videoResourceIdOverride ??
			videoIdFor(action.parentLessonId, action.videoSourcePath)
		if (action.target === 'solutionResource' && !opts.includeSolutions) {
			uploads.push({
				videoResourceId,
				parentLessonId: action.parentLessonId,
				videoSourcePath: action.videoSourcePath,
				target: action.target,
				action: 'skipped-solution',
			})
			continue
		}
		const existing = await db.query.contentResource.findFirst({
			where: eq(contentResource.id, videoResourceId),
		})
		if (existing && !action.replaceExisting) {
			uploads.push({
				videoResourceId,
				parentLessonId: action.parentLessonId,
				videoSourcePath: action.videoSourcePath,
				target: action.target,
				action: 'skipped-existing',
				publicUrl: (existing.fields as any)?.originalMediaUrl,
			})
			continue
		}
		if (existing && action.replaceExisting && opts.mode === 'dry-run') {
			uploads.push({
				videoResourceId,
				parentLessonId: action.parentLessonId,
				videoSourcePath: action.videoSourcePath,
				target: action.target,
				action: 'would-replace',
				replaceReason: action.replaceReason,
				publicUrl: (existing.fields as any)?.originalMediaUrl,
			})
			continue
		}
		if (opts.mode === 'dry-run') {
			uploads.push({
				videoResourceId,
				parentLessonId: action.parentLessonId,
				videoSourcePath: action.videoSourcePath,
				target: action.target,
				action: 'would-upload',
			})
			continue
		}
		const publicUrl = await uploadToS3(action.videoSourcePath, videoResourceId)
		await inngest.send({
			name: VIDEO_UPLOADED_EVENT,
			data: {
				originalMediaUrl: publicUrl,
				fileName: videoResourceId,
				title: action.title || basename(action.videoSourcePath),
				parentResourceId: action.parentLessonId,
				resourceId: videoResourceId,
			},
			user: { id: opts.createdById },
		})
		uploads.push({
			videoResourceId,
			parentLessonId: action.parentLessonId,
			videoSourcePath: action.videoSourcePath,
			target: action.target,
			action: 'uploaded',
			publicUrl,
		})
	}
	for (const action of scopedChapterActions) {
		const paired = scopedUploadActions.find(
			(u) =>
				u.parentLessonId === action.parentLessonId &&
				u.videoSourcePath === action.videoSourcePath,
		)
		const videoResourceId =
			paired?.videoResourceIdOverride ??
			videoIdFor(action.parentLessonId, action.videoSourcePath)
		if (paired?.target === 'solutionResource' && !opts.includeSolutions) {
			chapters.push({
				videoResourceId,
				videoSourcePath: action.videoSourcePath,
				chapterCount: action.chapterCount,
				action: 'skipped-solution',
			})
			continue
		}
		const existing = await db.query.contentResource.findFirst({
			where: eq(contentResource.id, videoResourceId),
		})
		if (!existing) {
			chapters.push({
				videoResourceId,
				videoSourcePath: action.videoSourcePath,
				chapterCount: action.chapterCount,
				action: 'missing-video-resource',
			})
			continue
		}
		if (opts.mode === 'dry-run' || !opts.backfillChapters) {
			chapters.push({
				videoResourceId,
				videoSourcePath: action.videoSourcePath,
				chapterCount: action.chapterCount,
				action: 'would-update',
			})
			continue
		}
		await db
			.update(contentResource)
			.set({
				fields: {
					...(existing.fields as any),
					chapters: action.chapters,
					chapterStatus: 'ready',
					sourcePath: action.videoSourcePath,
					chapterMetaPath: action.metaPath,
				},
			})
			.where(eq(contentResource.id, videoResourceId))
		chapters.push({
			videoResourceId,
			videoSourcePath: action.videoSourcePath,
			chapterCount: action.chapterCount,
			action: 'updated',
		})
	}
	for (const action of scopedUploadActions) {
		if (
			scopedChapterActions.some(
				(c) =>
					c.parentLessonId === action.parentLessonId &&
					c.videoSourcePath === action.videoSourcePath,
			)
		)
			continue
		if (action.target === 'solutionResource' && !opts.includeSolutions) continue
		chapters.push({
			videoResourceId: videoIdFor(
				action.parentLessonId,
				action.videoSourcePath,
			),
			videoSourcePath: action.videoSourcePath,
			chapterCount: 0,
			action: 'pending-no-meta',
		})
	}
	return {
		mode: opts.mode,
		generatedAt: new Date().toISOString(),
		manifestPath: opts.manifestPath,
		targetCohortId: opts.manifest.summary.targetCohortId,
		writesPerformed: opts.mode === 'apply',
		uploads,
		chapterBackfills: chapters,
	}
}

async function uploadToS3(videoSourcePath: string, videoResourceId: string) {
	const bucket = process.env.AWS_VIDEO_UPLOAD_BUCKET
	const region = process.env.AWS_VIDEO_UPLOAD_REGION
	if (!bucket || !region) throw new Error('Missing AWS video upload bucket env')
	const filePath = resolveManifestPath(dropboxRoot, videoSourcePath)
	const size = (await stat(filePath)).size
	const key = `${process.env.AWS_VIDEO_UPLOAD_FOLDER || 'partner-uploads'}/cohort-004/${videoResourceId}/${basename(videoSourcePath)}`
	const client = new S3Client({
		region,
		credentials: {
			accessKeyId: process.env.AWS_VIDEO_UPLOAD_ACCESS_KEY_ID!,
			secretAccessKey: process.env.AWS_VIDEO_UPLOAD_SECRET_ACCESS_KEY!,
		},
	})
	await client.send(
		new PutObjectCommand({
			Bucket: bucket,
			Key: key,
			Body: createReadStream(filePath),
			ContentLength: size,
			ContentType: contentTypeFor(videoSourcePath),
		}),
	)
	return `https://${bucket}.s3.${region}.amazonaws.com/${key}`
}
function videoIdFor(parentLessonId: string, videoSourcePath: string) {
	const suffix = videoSourcePath
		.toLowerCase()
		.replace(/\.[a-z0-9]+$/, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(-28)
	return `videoResource-${parentLessonId.replace(/^lesson-/, '')}-${suffix}`
}
function resolveManifestPath(rootPath: string, relativePath: string) {
	const root = resolve(rootPath)
	const filePath = resolve(root, relativePath)
	if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
		throw new Error(`Invalid videoSourcePath: ${relativePath}`)
	}
	return filePath
}

function contentTypeFor(path: string) {
	const p = path.toLowerCase()
	if (p.endsWith('.mov')) return 'video/quicktime'
	if (p.endsWith('.m4v')) return 'video/x-m4v'
	if (p.endsWith('.webm')) return 'video/webm'
	return 'video/mp4'
}
function summarize(r: any) {
	return {
		mode: r.mode,
		targetCohortId: r.targetCohortId,
		uploads: r.uploads.length,
		uploaded: r.uploads.filter((u: any) => u.action === 'uploaded').length,
		wouldUpload: r.uploads.filter((u: any) => u.action === 'would-upload')
			.length,
		wouldReplace: r.uploads.filter((u: any) => u.action === 'would-replace')
			.length,
		skippedExisting: r.uploads.filter(
			(u: any) => u.action === 'skipped-existing',
		).length,
		skippedSolutions: r.uploads.filter(
			(u: any) => u.action === 'skipped-solution',
		).length,
		chapterBackfills: r.chapterBackfills.length,
		chaptersUpdated: r.chapterBackfills.filter(
			(c: any) => c.action === 'updated',
		).length,
		chaptersPendingNoMeta: r.chapterBackfills.filter(
			(c: any) => c.action === 'pending-no-meta',
		).length,
		writesPerformed: r.writesPerformed,
	}
}

Effect.runPromise(program).catch((e) => {
	console.error(e)
	process.exit(1)
})
