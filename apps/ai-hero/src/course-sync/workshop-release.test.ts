import { describe, expect, it, vi } from 'vitest'
import {
	AI_HERO_COURSE_SYNC_BINDING_COHORT_005 as binding,
	AI_HERO_COURSE_SYNC_BINDING_COHORT_005_V7 as v7,
} from './types'
import {
	parseWorkshopReleaseArgs,
	releaseManagedWorkshop,
} from './workshop-release'

function harness(overrides: Record<string, unknown> = {}) {
	const options = {
		bindingId: binding.bindingId,
		workshopId: 'workshop-test',
		state: 'published' as const,
		allowWrite: false,
	}
	const row = {
		type: 'workshop',
		deletedAt: null,
		fields: {
			state: 'draft',
			visibility: 'unlisted',
			courseSync: {
				bindingId: binding.bindingId,
				sourceSectionId: 'source-test',
			},
		},
	}
	const relation = {
		resourceOfId: binding.anchorCohortId,
		metadata: { bindingId: binding.bindingId },
	}
	const execute = vi
		.fn()
		.mockResolvedValueOnce({
			rows: [{ binding, status: 'active' }],
			rowsAffected: 0,
		})
		.mockResolvedValueOnce({
			rows: [{ ...row, ...overrides }],
			rowsAffected: 0,
		})
		.mockResolvedValueOnce({ rows: [relation], rowsAffected: 0 })
		.mockResolvedValueOnce({ rows: [], rowsAffected: 1 })
		.mockResolvedValueOnce({ rows: [{ state: 'published' }], rowsAffected: 0 })
	return { options, execute, row, relation }
}

describe('managed workshop release operator', () => {
	it('defaults to dry run; writes require the exact flag', async () => {
		const test = harness()
		expect(
			parseWorkshopReleaseArgs([binding.bindingId, 'workshop-test']),
		).toEqual(test.options)
		await expect(
			releaseManagedWorkshop(test, test.options),
		).resolves.toMatchObject({ dryRun: true })
		expect(test.execute).toHaveBeenCalledTimes(3)
		expect(
			test.execute.mock.calls.every(([query]) => query.startsWith('SELECT')),
		).toBe(true)
	})
	it('changes only state with a conditional JSON_SET and verifies readback', async () => {
		const test = harness()
		await expect(
			releaseManagedWorkshop(test, { ...test.options, allowWrite: true }),
		).resolves.toEqual({
			bindingId: binding.bindingId,
			workshopId: 'workshop-test',
			fromState: 'draft',
			state: 'published',
			dryRun: false,
		})
		expect(test.execute.mock.calls[3]).toEqual([
			expect.stringContaining("SET fields = JSON_SET(fields, '$.state', ?)"),
			['published', 'workshop-test', 'draft'],
		])
		expect(test.execute).toHaveBeenCalledTimes(5)
	})
	it('supports the reverse published-to-draft transition for rollback', async () => {
		const test = harness()
		test.execute.mockReset()
		test.execute
			.mockResolvedValueOnce({ rows: [{ binding, status: 'active' }] })
			.mockResolvedValueOnce({
				rows: [
					{ ...test.row, fields: { ...test.row.fields, state: 'published' } },
				],
			})
			.mockResolvedValueOnce({ rows: [test.relation] })
			.mockResolvedValueOnce({ rowsAffected: 1 })
			.mockResolvedValueOnce({ rows: [{ state: 'draft' }] })
		const options = parseWorkshopReleaseArgs([
			binding.bindingId,
			'workshop-test',
			'--state',
			'draft',
			'--allow-write',
		])
		await expect(releaseManagedWorkshop(test, options)).resolves.toMatchObject({
			fromState: 'published',
			state: 'draft',
		})
	})
	it.each([
		v7,
		{ ...binding, status: 'suspended' },
		{ ...binding, productId: 'other' },
	])('refuses stale or drifted binding contracts', async (stored) => {
		const test = harness()
		test.execute
			.mockReset()
			.mockResolvedValueOnce({ rows: [{ binding: stored, status: 'active' }] })
		await expect(
			releaseManagedWorkshop(test, { ...test.options, allowWrite: true }),
		).rejects.toThrow('exact active v8')
		expect(test.execute).toHaveBeenCalledTimes(1)
	})
	it.each([
		{ type: 'lesson' },
		{ deletedAt: new Date() },
		{ fields: { state: 'published' } },
		{ fields: { state: 'draft', visibility: 'public' } },
		{
			fields: {
				state: 'draft',
				visibility: 'unlisted',
				courseSync: { bindingId: 'other' },
			},
		},
	])('refuses resources outside managed workshop scope', async (overrides) => {
		const test = harness(overrides)
		await expect(
			releaseManagedWorkshop(test, { ...test.options, allowWrite: true }),
		).rejects.toThrow()
		expect(test.execute).toHaveBeenCalledTimes(2)
	})
	it.each(['published', 'archived', 'deleted', null])(
		'refuses to overwrite a non-draft state (%s)',
		async (state) => {
			const test = harness()
			test.execute.mockReset()
			test.execute
				.mockResolvedValueOnce({ rows: [{ binding, status: 'active' }] })
				.mockResolvedValueOnce({
					rows: [{ ...test.row, fields: { ...test.row.fields, state } }],
				})
				.mockResolvedValueOnce({ rows: [test.relation] })
			await expect(
				releaseManagedWorkshop(test, { ...test.options, allowWrite: true }),
			).rejects.toThrow('required previous state')
			expect(test.execute).toHaveBeenCalledTimes(3)
		},
	)
	it.each([{ relations: [] }, { relations: [{ resourceOfId: 'other' }] }])(
		'refuses a missing or foreign cohort relation',
		async ({ relations }) => {
			const test = harness()
			test.execute.mockReset()
			test.execute
				.mockResolvedValueOnce({ rows: [{ binding, status: 'active' }] })
				.mockResolvedValueOnce({ rows: [test.row] })
				.mockResolvedValueOnce({ rows: relations })
			await expect(releaseManagedWorkshop(test, test.options)).rejects.toThrow(
				'exactly one managed relation',
			)
		},
	)
	it.each([0, 2])('refuses a write affecting %i rows', async (rowsAffected) => {
		const test = harness()
		test.execute.mockReset()
		test.execute
			.mockResolvedValueOnce({ rows: [{ binding, status: 'active' }] })
			.mockResolvedValueOnce({ rows: [test.row] })
			.mockResolvedValueOnce({ rows: [test.relation] })
			.mockResolvedValueOnce({ rowsAffected })
		await expect(
			releaseManagedWorkshop(test, { ...test.options, allowWrite: true }),
		).rejects.toThrow('exactly one workshop')
	})
	it('refuses failed readback', async () => {
		const test = harness()
		test.execute.mockReset()
		test.execute
			.mockResolvedValueOnce({ rows: [{ binding, status: 'active' }] })
			.mockResolvedValueOnce({ rows: [test.row] })
			.mockResolvedValueOnce({ rows: [test.relation] })
			.mockResolvedValueOnce({ rowsAffected: 1 })
			.mockResolvedValueOnce({ rows: [{ state: 'draft' }] })
		await expect(
			releaseManagedWorkshop(test, { ...test.options, allowWrite: true }),
		).rejects.toThrow('readback failed')
	})
	it.each(
		[
			[],
			['a'],
			['a', 'b', '--yes'],
			['a', 'b', '--state', 'public'],
			['a', 'b', '--allow-write', '--allow-write'],
		].map((args) => ({ args })),
	)('rejects invalid arguments $args', ({ args }) => {
		expect(() => parseWorkshopReleaseArgs(args)).toThrow()
	})
})
