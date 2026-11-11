import { describe, expect, it, vi } from 'vitest'

vi.mock('@/server/auth', () => ({ getServerAuthSession: vi.fn() }))

import { appRouter } from './root'
import type { AccessMeta } from './trpc'

// tRPC v11 flattens procedures at runtime; its public type retains nested routers
// and hides the output parser. Keep this internal shape local to the inventory.
type InventoryProcedure = {
	_def: { meta?: Partial<AccessMeta>; output?: unknown }
}

// Flip only after the remaining routers have explicit access and safe outputs.
const ACCESS_ENFORCE = false

describe('tRPC access inventory', () => {
	it('reports undeclared access and missing outputs without blocking migration', () => {
		const rows: Record<
			string,
			{ missingAccess: string[]; missingOutput: string[]; learner: string[] }
		> = {}
		for (const [path, procedure] of Object.entries(
			appRouter._def.procedures as unknown as Record<
				string,
				InventoryProcedure
			>,
		).sort(([a], [b]) => a.localeCompare(b))) {
			const router = path.split('.')[0]!
			const row = (rows[router] ??= {
				missingAccess: [],
				missingOutput: [],
				learner: [],
			})
			const access = procedure._def.meta?.access
			if (!access) row.missingAccess.push(path)
			// Unannotated legacy procedures also need an output during migration.
			if (
				(!access || ['public', 'session', 'learner'].includes(access.kind)) &&
				!procedure._def.output
			) {
				row.missingOutput.push(path)
			}
			if (access?.kind === 'learner') row.learner.push(path)
		}
		console.info(
			[
				'router | missing access | missing output | learner (manual ownership review)',
				...Object.entries(rows).map(
					([router, row]) =>
						`${router} | ${row.missingAccess.length} | ${row.missingOutput.length} | ${row.learner.length}`,
				),
				...Object.entries(rows).flatMap(([router, row]) =>
					Object.entries(row).map(
						([kind, paths]) => `${router}.${kind}: ${paths.join(', ') || '-'}`,
					),
				),
			].join('\n'),
		)
		if (ACCESS_ENFORCE) {
			expect(Object.values(rows).flatMap((row) => row.missingAccess)).toEqual(
				[],
			)
			expect(Object.values(rows).flatMap((row) => row.missingOutput)).toEqual(
				[],
			)
		}
	})
})
