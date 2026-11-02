import { stableValue } from './binding-migration'
import { AI_HERO_COURSE_SYNC_BINDING_COHORT_005 as v8 } from './types'

export class WorkshopReleaseRefused extends Error {}

export type WorkshopReleaseOptions = {
	bindingId: string
	workshopId: string
	state: 'draft' | 'published'
	allowWrite: boolean
}

export function parseWorkshopReleaseArgs(
	args: string[],
): WorkshopReleaseOptions {
	const [bindingId, workshopId, ...flags] = args
	if (
		!bindingId ||
		!workshopId ||
		bindingId.startsWith('--') ||
		workshopId.startsWith('--')
	) {
		throw new WorkshopReleaseRefused('Expected binding id and workshop id.')
	}
	let state: WorkshopReleaseOptions['state'] = 'published'
	let allowWrite = false
	let sawState = false
	for (let i = 0; i < flags.length; i++) {
		if (flags[i] === '--allow-write' && !allowWrite) allowWrite = true
		else if (flags[i] === '--state' && !sawState) {
			const value = flags[++i]
			if (value !== 'draft' && value !== 'published')
				throw new WorkshopReleaseRefused('Invalid target state.')
			state = value
			sawState = true
		} else
			throw new WorkshopReleaseRefused('Unknown or duplicate release argument.')
	}
	return { bindingId, workshopId, state, allowWrite }
}

type QueryResult = {
	rows: Array<Record<string, unknown>>
	rowsAffected: number
}
export type WorkshopReleaseTransaction = {
	execute(query: string, args?: unknown[]): Promise<QueryResult>
}

function json(value: unknown): Record<string, unknown> {
	const parsed = typeof value === 'string' ? JSON.parse(value) : value
	return parsed && typeof parsed === 'object'
		? (parsed as Record<string, unknown>)
		: {}
}

/** Caller owns the transaction. Lock the binding first, as apply/rollback do. */
export async function releaseManagedWorkshop(
	tx: WorkshopReleaseTransaction,
	options: WorkshopReleaseOptions,
) {
	const { bindingId, workshopId, state, allowWrite } = options
	const stored = await tx.execute(
		'SELECT binding, status FROM AI_CourseSyncBinding WHERE bindingId = ? FOR UPDATE',
		[bindingId],
	)
	const binding = json(stored.rows[0]?.binding)
	if (
		bindingId !== v8.bindingId ||
		stored.rows.length !== 1 ||
		stored.rows[0]?.status !== 'active' ||
		JSON.stringify(stableValue(binding)) !== JSON.stringify(stableValue(v8))
	) {
		throw new WorkshopReleaseRefused(
			'Stored binding must be the exact active v8 release contract. Deploy and migrate it first.',
		)
	}
	const resources = await tx.execute(
		'SELECT id, type, fields, deletedAt FROM AI_ContentResource WHERE id = ? FOR UPDATE',
		[workshopId],
	)
	const resource = resources.rows[0]
	const fields = json(resource?.fields)
	const sync = json(fields.courseSync)
	if (
		resources.rows.length !== 1 ||
		resource?.type !== 'workshop' ||
		resource.deletedAt !== null ||
		fields.visibility !== 'unlisted' ||
		sync.bindingId !== bindingId ||
		sync.active === false ||
		typeof sync.sourceSectionId !== 'string'
	) {
		throw new WorkshopReleaseRefused(
			'Resource must be a live managed unlisted workshop in this binding.',
		)
	}
	const relations = await tx.execute(
		'SELECT resourceOfId, metadata FROM AI_ContentResourceResource WHERE resourceId = ? AND deletedAt IS NULL FOR UPDATE',
		[workshopId],
	)
	if (
		relations.rows.length !== 1 ||
		relations.rows[0]?.resourceOfId !== v8.anchorCohortId ||
		json(relations.rows[0]?.metadata).bindingId !== bindingId
	) {
		throw new WorkshopReleaseRefused(
			'Workshop must have exactly one managed relation under the bound cohort.',
		)
	}
	const fromState = state === 'published' ? 'draft' : 'published'
	if (fields.state !== fromState)
		throw new WorkshopReleaseRefused(
			'Workshop is not in the required previous state; refusing overwrite.',
		)
	if (allowWrite) {
		const result = await tx.execute(
			`UPDATE AI_ContentResource SET fields = JSON_SET(fields, '$.state', ?)
			 WHERE id = ? AND type = 'workshop' AND deletedAt IS NULL
			 AND JSON_UNQUOTE(JSON_EXTRACT(fields, '$.state')) = ?`,
			[state, workshopId, fromState],
		)
		if (result.rowsAffected !== 1)
			throw new WorkshopReleaseRefused(
				'Conditional state update did not change exactly one workshop.',
			)
		const readback = await tx.execute(
			`SELECT JSON_UNQUOTE(JSON_EXTRACT(fields, '$.state')) AS state FROM AI_ContentResource WHERE id = ?`,
			[workshopId],
		)
		if (readback.rows.length !== 1 || readback.rows[0]?.state !== state)
			throw new WorkshopReleaseRefused('State readback failed.')
	}
	return { bindingId, workshopId, fromState, state, dryRun: !allowWrite }
}
