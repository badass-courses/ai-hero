import { createMongoAbility, subject, type RawRuleOf } from '@casl/ability'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import type { AppAbility } from '@/ability'

vi.mock('@/server/auth', () => ({ getServerAuthSession: vi.fn() }))
vi.mock('@/server/logger', () => ({ log: { warn: vi.fn() } }))
vi.mock('@/db', () => ({ db: {} }))

import { log } from '@/server/logger'
import {
	assertCan,
	createTRPCRouter,
	procedure,
	publicProcedure,
	type AccessMeta,
} from './trpc'

const definition = (proc: { _def: unknown }) =>
	proc._def as { meta?: Partial<AccessMeta>; output?: unknown }

const router = createTRPCRouter({
	public: procedure
		.public({ reason: 'Synthetic test' })
		.output(z.object({ ok: z.boolean() }))
		.query(() => ({ ok: true, secret: 'stripped' })),
	session: procedure
		.session()
		.output(z.boolean())
		.query(() => true),
	learner: procedure
		.learner('User')
		.output(z.boolean())
		.query(({ ctx }) => {
			assertCan(ctx.ability, 'read', subject('User', { id: 'other' }))
			return true
		}),
	can: procedure.can('read', 'User').query(() => true),
	editor: procedure.editor().query(() => true),
	admin: procedure.admin().query(() => true),
	legacy: publicProcedure.query(() => true),
})

function caller(authed = false, rules: RawRuleOf<AppAbility>[] = []) {
	return router.createCaller({
		session: authed ? { user: { id: 'self' } } : null,
		ability: createMongoAbility(rules),
		headers: new Headers(),
		db: {},
	} as any)
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('access-declaring builders', () => {
	it('keeps public and legacy procedures anonymous; strips extra output fields', async () => {
		expect(await caller().public()).toEqual({ ok: true })
		expect(await caller().legacy()).toBe(true)
		expect(log.warn).not.toHaveBeenCalled()
	})
	it.each(['session', 'learner', 'can', 'editor', 'admin'] as const)(
		'%s checks the session before ability',
		async (name) => {
			await expect(caller()[name]()).rejects.toMatchObject({
				code: 'UNAUTHORIZED',
			})
			expect(log.warn).toHaveBeenCalledTimes(1)
			expect(log.warn).toHaveBeenCalledWith('access.denied', {
				procedure: name,
				kind: name === 'editor' || name === 'admin' ? 'can' : name,
			})
		},
	)
	it.each(['learner', 'can', 'editor', 'admin'] as const)(
		'%s denies insufficient permissions once',
		async (name) => {
			await expect(caller(true)[name]()).rejects.toMatchObject({
				code: 'FORBIDDEN',
			})
			expect(log.warn).toHaveBeenCalledTimes(1)
		},
	)
	it('allows sessions and explicitly granted type-level permissions', async () => {
		expect(await caller(true).session()).toBe(true)
		const admin = caller(true, [{ action: 'manage', subject: 'all' }])
		for (const name of ['learner', 'can', 'editor', 'admin'] as const)
			expect(await admin[name]()).toBe(true)
	})
	it('stores the tRPC v11 output parser for inventory detection', () => {
		for (const name of ['public', 'session', 'learner'] as const) {
			expect(definition(router._def.procedures[name]).output).toBeDefined()
		}
		expect(definition(router._def.procedures.legacy).output).toBeUndefined()
	})
	it('sets access metadata on every new builder', () => {
		for (const [name, proc] of Object.entries(router._def.procedures)) {
			if (name !== 'legacy') expect(definition(proc).meta?.access).toBeDefined()
		}
	})
})

// These branches never execute. tsc verifies output is required before attaching a resolver.
if (false) {
	// @ts-expect-error public output must be declared first
	procedure.public({ reason: 'test' }).query(() => true)
	// @ts-expect-error session output must be declared first
	procedure.session().query(() => true)
	// @ts-expect-error learner output must be declared first
	procedure.learner('User').query(() => true)
}
