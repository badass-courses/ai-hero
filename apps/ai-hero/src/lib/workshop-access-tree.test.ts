import {
	createAppAbility,
	defineRulesForPurchases,
	UserSchema,
} from '@/ability'
import { LessonSchema } from '@/lib/lessons'
import { getWorkshop, getWorkshopAccessTree } from '@/lib/workshops-query'
import { getResourceSection } from '@/utils/get-resource-section'
import { getWorkshopResourceIds } from '@/utils/get-workshop-resource-ids'
import { subject } from '@casl/ability'
import { type SQL } from 'drizzle-orm'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { purchaseSchema } from '@coursebuilder/core/schemas'

const mocks = vi.hoisted(() => ({ findFirst: vi.fn(), can: vi.fn() }))
vi.mock('@/db', () => ({
	db: { query: { contentResource: { findFirst: mocks.findFirst } } },
}))
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }))
vi.mock('@/server/auth', () => ({
	getServerAuthSession: async () => ({ ability: { can: mocks.can } }),
}))
vi.mock('@/lib/content-navigation-query', () => ({}))
vi.mock('@/lib/content-edit-guard', () => ({}))
vi.mock('./typesense-query', () => ({}))
vi.mock('@/server/logger', () => ({ log: { error: vi.fn() } }))
vi.mock('@/server/perf', () => ({
	measureIfSlow: ({ operation }: { operation: () => Promise<unknown> }) =>
		operation(),
}))

const timestamps = { createdAt: null, updatedAt: null, deletedAt: null }
const base = {
	...timestamps,
	createdById: 'writer',
	organizationId: null,
	createdByOrganizationMembershipId: null,
}
const id = 'workshop-id'
const slug = 'workshop-slug'
const leaf = (id: string, type: string) => ({
	...base,
	id,
	type,
	fields: { title: id, slug: id, body: 'Unused body', transcript: 'Unused' },
})
const edge = <T extends { id: string }>(
	resourceOfId: string,
	resource: T,
	position: number,
	metadata: object | null,
) => ({
	...timestamps,
	resourceOfId,
	resourceId: resource.id,
	position,
	metadata,
	resource,
})

const solution = leaf('solution-id', 'solution')
const lesson = leaf('nested-lesson', 'lesson')
const exercise = leaf('nested-exercise', 'exercise')
const topExercise = leaf('top-exercise', 'exercise')
const paidLesson = leaf('paid-lesson', 'lesson')
const section = leaf('free-section', 'section')
const sectionEdges = [
	edge(section.id, lesson, 1, { tier: 'paid' }),
	edge(section.id, exercise, 2, null),
]
const productJoin = {
	...timestamps,
	resourceId: id,
	productId: 'product-id',
	position: 4,
	metadata: { tier: 'paid' },
}

function fullRow(startsAt: string) {
	return {
		...leaf(id, 'workshop'),
		fields: { title: 'Workshop', slug, visibility: 'private', startsAt },
		resources: [
			edge(id, { ...section, resources: sectionEdges }, 1, {
				tier: 'free',
				note: 'preserved',
			}),
			edge(
				id,
				{
					...topExercise,
					resources: [edge(topExercise.id, solution, 1, null)],
				},
				2,
				{ tier: 'free' },
			),
			edge(id, { ...paidLesson, resources: [] }, 3, { tier: 'paid' }),
		],
		resourceProducts: [
			{ ...productJoin, product: { id: 'product-id', price: {} } },
		],
	}
}

// Fixture returned by the projected query, including both sets of join rows.
function projectedRow(full: ReturnType<typeof fullRow>) {
	return {
		...full,
		resources: full.resources.map(({ resource, ...join }) => ({
			...join,
			resource: {
				id: resource.id,
				type: resource.type,
				resources: resource.resources.map(({ resource, ...join }) => ({
					...join,
					resource: { id: resource.id, type: resource.type },
				})),
			},
		})),
		resourceProducts: [productJoin],
	}
}

const positionSql = (orderBy: SQL) => new MySqlDialect().sqlToQuery(orderBy)

function expectProjection() {
	const [fullQuery, accessQuery] = mocks.findFirst.mock.calls.map(
		([query]) => query,
	)
	const top = accessQuery.with.resources
	const children = top.with.resource.with.resources
	expect(positionSql(top.orderBy)).toEqual(
		positionSql(fullQuery.with.resources.orderBy),
	)
	expect(positionSql(children.orderBy)).toEqual(
		positionSql(fullQuery.with.resources.with.resource.with.resources.orderBy),
	)
	expect(top.columns).toBeUndefined()
	expect(children.columns).toBeUndefined()
	expect(top.with.resource.columns).toEqual({ id: true, type: true })
	expect(children.with).toEqual({
		resource: { columns: { id: true, type: true } },
	})
	expect(accessQuery.with.resourceProducts).toBe(true)
}

describe('workshop access tree', () => {
	afterEach(() => {
		vi.resetAllMocks()
		vi.useRealTimers()
	})

	it.each([
		{ key: slug, editor: false },
		{ key: id, editor: true },
	])(
		'preserves lookup and visibility ($key, editor=$editor)',
		async ({ key, editor }) => {
			const full = fullRow('2026-11-10T00:00:00.000Z')
			mocks.can.mockReturnValue(editor)
			mocks.findFirst.mockResolvedValueOnce(editor ? full : undefined)
			mocks.findFirst.mockResolvedValueOnce(
				editor ? projectedRow(full) : undefined,
			)
			const legacy = await getWorkshop(key)
			const slim = await getWorkshopAccessTree(key)
			const [original, projected] = mocks.findFirst.mock.calls.map(([query]) =>
				new MySqlDialect().sqlToQuery(query.where),
			)
			expect(projected).toEqual(original)
			expect(projected.sql).toContain('$.slug')
			expect(projected.sql).toContain('$.visibility')
			expect(projected.params).toEqual([
				key,
				key,
				'workshop',
				'public',
				...(editor ? ['private'] : []),
				'unlisted',
			])
			expect(mocks.can.mock.calls).toEqual([
				['update', 'Content'],
				['update', 'Content'],
			])
			expect(slim?.id ?? null).toBe(legacy?.id ?? null)
			expect(slim?.id ?? null).toBe(editor ? id : null)
			expectProjection()
		},
	)

	it.each([
		{ startsAt: '2026-11-10T00:00:00.000Z', open: true },
		{ startsAt: '2026-11-30T00:00:00.000Z', open: false },
	])(
		'preserves rules and membership (cohort open=$open)',
		async ({ startsAt, open }) => {
			vi.useFakeTimers()
			vi.setSystemTime(new Date('2026-11-20T00:00:00.000Z'))
			const row = fullRow(startsAt)
			const projected = projectedRow(row)
			mocks.can.mockReturnValue(true)
			mocks.findFirst
				.mockResolvedValueOnce(row)
				.mockResolvedValueOnce(projected)
			const full = (await getWorkshop(slug))!
			const slim = (await getWorkshopAccessTree(slug))!
			expect(slim.resources).toEqual(projected.resources)
			expect(slim.resourceProducts).toEqual([productJoin])
			expect(slim.fields).toEqual({ startsAt })

			const fullIds = getWorkshopResourceIds(full)
			const slimIds = getWorkshopResourceIds(slim)
			expect(slimIds).toEqual(fullIds)
			expect(slimIds).toEqual([
				section.id,
				lesson.id,
				exercise.id,
				topExercise.id,
				solution.id,
				paidLesson.id,
			])

			for (const [lookup, expected] of [
				[section.id, section.id],
				[lesson.id, section.id],
				[exercise.id, section.id],
				[topExercise.id, null],
				[solution.id, null],
				['missing', null],
			] as const) {
				const original = await getResourceSection(lookup, full)
				const projected = await getResourceSection(lookup, slim)
				expect(projected?.id ?? null).toBe(original?.id ?? null)
				expect(projected?.id ?? null).toBe(expected)
				expect(projected?.resources.map((edge) => edge.resourceId)).toEqual(
					original?.resources.map((edge) => edge.resourceId),
				)
			}

			const viewer = UserSchema.parse({ id: 'viewer' })
			const entitledViewer = {
				...viewer,
				entitlements: [{ type: 'cohort', metadata: { contentIds: [id] } }],
			}
			const purchase = purchaseSchema.parse({
				id: 'purchase',
				createdAt: new Date(),
				totalAmount: 10,
				bulkCouponId: null,
				productId: productJoin.productId,
				status: 'Restricted',
				country: 'AU',
			})
			for (const resource of [
				lesson,
				exercise,
				topExercise,
				solution,
				paidLesson,
			]) {
				for (const user of [undefined, viewer, entitledViewer]) {
					const input = {
						user,
						lesson: LessonSchema.parse(resource),
						purchases: [purchase],
						country: 'US',
						entitlementTypes: [{ id: 'cohort', name: 'cohort_content_access' }],
					}
					const rules = defineRulesForPurchases({
						...input,
						module: slim,
						allModuleResourceIds: slimIds,
						section: (await getResourceSection(resource.id, slim)) ?? undefined,
					})
					expect(rules).toEqual(
						defineRulesForPurchases({
							...input,
							module: full,
							allModuleResourceIds: fullIds,
							section:
								(await getResourceSection(resource.id, full)) ?? undefined,
						}),
					)
					const ability = createAppAbility(rules)
					const free = [lesson.id, exercise.id, topExercise.id].includes(
						resource.id,
					)
					expect(
						ability.can('read', subject('Content', { id: resource.id })),
					).toBe(free || (user === entitledViewer && open))
					expect(ability.can('read', 'PendingOpenAccess')).toBe(
						user === entitledViewer && !open,
					)
					expect(ability.can('read', 'RegionRestriction')).toBe(Boolean(user))
				}
			}
		},
	)

	it('reads membership afresh and preserves legacy validation failures', async () => {
		const row = fullRow('2026-11-10T00:00:00.000Z')
		const projected = projectedRow(row)
		// Invalid title, despite a valid lookup, date, and otherwise granting tree.
		const fields = { ...row.fields, title: '' }
		mocks.can.mockReturnValue(true)
		mocks.findFirst
			.mockResolvedValueOnce(projected)
			.mockResolvedValueOnce({ ...projected, resources: [] })
			.mockResolvedValueOnce({ ...row, fields })
			.mockResolvedValueOnce({ ...projected, fields })
		expect(getWorkshopResourceIds(await getWorkshopAccessTree(slug))).toContain(
			lesson.id,
		)
		expect(getWorkshopResourceIds(await getWorkshopAccessTree(slug))).toEqual(
			[],
		)
		expect(await getWorkshop(slug)).toBeNull()
		expect(await getWorkshopAccessTree(slug)).toBeNull()
		expect(mocks.findFirst).toHaveBeenCalledTimes(4)
	})
})
