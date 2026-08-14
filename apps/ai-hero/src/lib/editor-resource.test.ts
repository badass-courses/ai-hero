import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
	buildEditorResourceRevision,
	canAccessEditorResource,
	createEditorResourceVersionId,
	createEditorResourceService,
	EditorResourceError,
	type EditorAccessContext,
	type EditorResourceRecord,
	type EditorResourceRepository,
	type EditorResourceVersion,
	type VersionedMutationInput,
} from './editor-resource'

const editor: EditorAccessContext = { userId: 'user_editor', isAdmin: false }
const stranger: EditorAccessContext = {
	userId: 'user_stranger',
	isAdmin: false,
}

function resource(
	overrides: Partial<EditorResourceRecord> = {},
): EditorResourceRecord {
	return {
		id: 'workshop_1',
		type: 'workshop',
		createdById: 'user_owner',
		fields: {
			title: 'Crash Course',
			slug: 'crash-course',
			state: 'draft',
			visibility: 'unlisted',
			timezone: 'America/Los_Angeles',
		},
		currentVersionId: null,
		createdAt: new Date('2026-08-14T00:00:00.000Z'),
		updatedAt: new Date('2026-08-14T00:00:00.000Z'),
		deletedAt: null,
		organizationId: null,
		createdByOrganizationMembershipId: null,
		contributions: [
			{
				userId: editor.userId,
				active: true,
				deletedAt: null,
				contributionType: {
					slug: 'editor',
					active: true,
					deletedAt: null,
				},
			},
		],
		...overrides,
	}
}

function cloneResource(value: EditorResourceRecord): EditorResourceRecord {
	return {
		...value,
		fields: structuredClone(value.fields),
		contributions: structuredClone(value.contributions),
	}
}

class FakeRepository implements EditorResourceRepository {
	resources = new Map<string, EditorResourceRecord>()
	versions = new Map<string, EditorResourceVersion[]>()
	sequence = 0

	constructor(initial: EditorResourceRecord[]) {
		for (const item of initial) this.resources.set(item.id, cloneResource(item))
	}

	async listCandidates() {
		return [...this.resources.values()].map(cloneResource)
	}

	async getResource(resourceId: string) {
		const item = this.resources.get(resourceId)
		return item ? cloneResource(item) : null
	}

	async getVersion(resourceId: string, versionId: string) {
		return (
			this.versions
				.get(resourceId)
				?.find((version) => version.id === versionId) ?? null
		)
	}

	async listVersions(resourceId: string) {
		return [...(this.versions.get(resourceId) ?? [])].sort(
			(left, right) => right.versionNumber - left.versionNumber,
		)
	}

	async commitVersionedMutation(input: VersionedMutationInput) {
		const current = this.resources.get(input.resourceId)
		if (!current || !canAccessEditorResource(current, input)) {
			throw new EditorResourceError('Resource not found', 404, 'not-found')
		}
		if (buildEditorResourceRevision(current) !== input.expectedRevision) {
			throw new EditorResourceError('stale', 409, 'conflict')
		}

		const existing = this.versions.get(current.id) ?? []
		const selected = input.rollbackVersionId
			? existing.find((version) => version.id === input.rollbackVersionId)
			: null
		if (input.rollbackVersionId && !selected) {
			throw new EditorResourceError('Version not found', 404, 'not-found')
		}
		const fields = structuredClone(selected?.fields ?? input.fields ?? {})
		const now = new Date(
			Date.parse('2026-08-14T00:00:00.000Z') + ++this.sequence * 1000,
		)
		const nextNumber = (existing.at(-1)?.versionNumber ?? 0) + 1
		const baselineVersion: EditorResourceVersion | null =
			current.currentVersionId
				? null
				: {
						id: `version_${this.sequence}_baseline`,
						resourceId: current.id,
						parentVersionId: null,
						versionNumber: nextNumber,
						fields: structuredClone(current.fields ?? {}),
						createdAt: now,
						createdById: input.userId,
					}
		const version: EditorResourceVersion = {
			id: `version_${this.sequence}`,
			resourceId: current.id,
			parentVersionId: baselineVersion?.id ?? current.currentVersionId,
			versionNumber: nextNumber + (baselineVersion ? 1 : 0),
			fields,
			createdAt: now,
			createdById: input.userId,
		}
		const next = {
			...current,
			fields,
			currentVersionId: version.id,
			updatedAt: now,
		}
		this.resources.set(current.id, next)
		this.versions.set(current.id, [
			...existing,
			...(baselineVersion ? [baselineVersion] : []),
			version,
		])
		return {
			previousResource: cloneResource(current),
			resource: cloneResource(next),
			version,
			baselineVersion,
		}
	}
}

const effects = { afterWrite: vi.fn() }

beforeEach(() => {
	effects.afterWrite.mockReset()
	effects.afterWrite.mockResolvedValue(undefined)
})

describe('editor resource authorization', () => {
	it('creates globally unique ids with a resource-bound identity segment', () => {
		const first = createEditorResourceVersionId('workshop_1')
		const second = createEditorResourceVersionId('workshop_2')

		expect(first).toMatch(/^version~[a-f0-9]{16}~/)
		expect(second).toMatch(/^version~[a-f0-9]{16}~/)
		expect(first.split('~')[1]).not.toBe(second.split('~')[1])
	})

	it('uses an active editor contribution as the exact resource grant', () => {
		expect(canAccessEditorResource(resource(), editor)).toBe(true)
		expect(canAccessEditorResource(resource(), stranger)).toBe(false)
	})

	it('rejects the wrong, inactive, or deleted contribution and type', () => {
		for (const contribution of [
			{
				userId: editor.userId,
				active: true,
				deletedAt: null,
				contributionType: {
					slug: 'author',
					active: true,
					deletedAt: null,
				},
			},
			{
				userId: editor.userId,
				active: false,
				deletedAt: null,
				contributionType: {
					slug: 'editor',
					active: true,
					deletedAt: null,
				},
			},
			{
				userId: editor.userId,
				active: true,
				deletedAt: new Date(),
				contributionType: {
					slug: 'editor',
					active: true,
					deletedAt: null,
				},
			},
			{
				userId: editor.userId,
				active: true,
				deletedAt: null,
				contributionType: {
					slug: 'editor',
					active: false,
					deletedAt: null,
				},
			},
			{
				userId: editor.userId,
				active: true,
				deletedAt: null,
				contributionType: {
					slug: 'editor',
					active: true,
					deletedAt: new Date(),
				},
			},
		]) {
			expect(
				canAccessEditorResource(
					resource({ contributions: [contribution] }),
					editor,
				),
			).toBe(false)
		}
	})

	it('keeps admin and creator compatibility without a contributor role', () => {
		expect(
			canAccessEditorResource(resource({ contributions: [] }), {
				userId: 'admin',
				isAdmin: true,
			}),
		).toBe(true)
		expect(
			canAccessEditorResource(resource({ contributions: [] }), {
				userId: 'user_owner',
				isAdmin: false,
			}),
		).toBe(true)
	})
})

describe('editor resource service', () => {
	it('lists and reads only assigned resources', async () => {
		const assigned = resource()
		const unassigned = resource({ id: 'workshop_2', contributions: [] })
		const repository = new FakeRepository([assigned, unassigned])
		const service = createEditorResourceService(repository, effects)

		await expect(service.list(editor)).resolves.toMatchObject([
			{ resource: { id: assigned.id } },
		])
		await expect(service.get(unassigned.id, editor)).rejects.toMatchObject({
			status: 404,
			code: 'not-found',
		})
	})

	it('creates a baseline and candidate on the first write', async () => {
		const repository = new FakeRepository([resource()])
		const service = createEditorResourceService(repository, effects)
		const read = await service.get('workshop_1', editor)
		const result = await service.update(
			'workshop_1',
			{ action: 'save', fields: { body: 'First edit' } },
			read.revision,
			editor,
		)

		expect(result.baselineVersion).toMatchObject({
			versionNumber: 1,
			parentVersionId: null,
			fields: { title: 'Crash Course' },
		})
		expect(result.version).toMatchObject({
			versionNumber: 2,
			parentVersionId: result.baselineVersion?.id,
			fields: { body: 'First edit' },
		})
		expect(result.resource.currentVersionId).toBe(result.version.id)
	})

	it('chains normal versions and rejects stale writes with 409', async () => {
		const repository = new FakeRepository([resource()])
		const service = createEditorResourceService(repository, effects)
		const initial = await service.get('workshop_1', editor)
		const first = await service.update(
			'workshop_1',
			{ action: 'save', fields: { body: 'one' } },
			initial.revision,
			editor,
		)
		const second = await service.update(
			'workshop_1',
			{ action: 'save', fields: { body: 'two' } },
			first.revision,
			editor,
		)

		expect(second.baselineVersion).toBeNull()
		expect(second.version).toMatchObject({
			versionNumber: 3,
			parentVersionId: first.version.id,
		})
		await expect(
			service.update(
				'workshop_1',
				{ action: 'save', fields: { body: 'stale' } },
				initial.revision,
				editor,
			),
		).rejects.toMatchObject({ status: 409, code: 'conflict' })
	})

	it('edits a customer-visible draft/unlisted resource and publishes explicitly', async () => {
		const repository = new FakeRepository([resource()])
		const service = createEditorResourceService(repository, effects)
		const initial = await service.get('workshop_1', editor)
		const saved = await service.update(
			'workshop_1',
			{ action: 'save', fields: { body: 'Live copy edit' } },
			initial.revision,
			editor,
		)

		expect(saved.resource.fields).toMatchObject({
			state: 'draft',
			visibility: 'unlisted',
			body: 'Live copy edit',
		})

		const published = await service.update(
			'workshop_1',
			{ action: 'publish', fields: {} },
			saved.revision,
			editor,
		)
		expect(published.resource.fields).toMatchObject({ state: 'published' })
		expect(published.resource.fields.publishedAt).toEqual(expect.any(String))
		expect(effects.afterWrite).toHaveBeenLastCalledWith(
			expect.objectContaining({ action: 'publish', userId: editor.userId }),
		)
	})

	it('validates the exact selected rollback snapshot before persistence', async () => {
		const repository = new FakeRepository([resource()])
		repository.versions.set('workshop_1', [
			{
				id: 'invalid_version',
				resourceId: 'workshop_1',
				parentVersionId: null,
				versionNumber: 1,
				fields: { state: 'draft', slug: 'crash-course' },
				createdAt: new Date(),
				createdById: editor.userId,
			},
		])
		const service = createEditorResourceService(repository, effects)
		const initial = await service.get('workshop_1', editor)

		await expect(
			service.rollback(
				'workshop_1',
				'invalid_version',
				initial.revision,
				editor,
			),
		).rejects.toMatchObject({ status: 400, code: 'invalid-input' })
		expect(repository.resources.get('workshop_1')?.currentVersionId).toBeNull()
	})

	it('runs effects only after the versioned commit returns', async () => {
		const repository = new FakeRepository([resource()])
		const order: string[] = []
		const commit = repository.commitVersionedMutation.bind(repository)
		vi.spyOn(repository, 'commitVersionedMutation').mockImplementation(
			async (input) => {
				const result = await commit(input)
				order.push('commit-returned')
				return result
			},
		)
		const orderedEffects = {
			afterWrite: vi.fn(async () => {
				order.push('effects')
			}),
		}
		const service = createEditorResourceService(repository, orderedEffects)
		const initial = await service.get('workshop_1', editor)

		await service.update(
			'workshop_1',
			{ action: 'save', fields: { body: 'post-commit' } },
			initial.revision,
			editor,
		)
		expect(order).toEqual(['commit-returned', 'effects'])
	})

	it('edits and publishes an assigned live page stored as draft/unlisted', async () => {
		const page = resource({
			id: 'page_1',
			type: 'page',
			fields: {
				title: 'Crash Course Landing Page',
				slug: 'crash-course',
				body: 'Public copy',
				state: 'draft',
				visibility: 'unlisted',
			},
		})
		const repository = new FakeRepository([page])
		const service = createEditorResourceService(repository, effects)
		const initial = await service.get(page.id, editor)
		const saved = await service.update(
			page.id,
			{ action: 'save', fields: { body: 'Revised public copy' } },
			initial.revision,
			editor,
		)

		expect(saved.resource.fields).toMatchObject({
			body: 'Revised public copy',
			state: 'draft',
			visibility: 'unlisted',
		})
		const published = await service.update(
			page.id,
			{ action: 'publish', fields: {} },
			saved.revision,
			editor,
		)
		expect(published.resource.fields.state).toBe('published')
	})

	it('rolls back by creating a new child version', async () => {
		const repository = new FakeRepository([resource()])
		const service = createEditorResourceService(repository, effects)
		const initial = await service.get('workshop_1', editor)
		const first = await service.update(
			'workshop_1',
			{ action: 'save', fields: { body: 'one' } },
			initial.revision,
			editor,
		)
		const second = await service.update(
			'workshop_1',
			{ action: 'save', fields: { body: 'two' } },
			first.revision,
			editor,
		)
		const rolledBack = await service.rollback(
			'workshop_1',
			first.version.id,
			second.revision,
			editor,
		)

		expect(rolledBack.version).toMatchObject({
			versionNumber: 4,
			parentVersionId: second.version.id,
			fields: { body: 'one' },
		})
		expect(rolledBack.version.id).not.toBe(first.version.id)
		expect(rolledBack.resource.currentVersionId).toBe(rolledBack.version.id)
		expect(effects.afterWrite).toHaveBeenLastCalledWith(
			expect.objectContaining({ action: 'rollback' }),
		)
	})
})
