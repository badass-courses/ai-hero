/**
 * YOU PROBABLY DON'T NEED TO EDIT THIS FILE, UNLESS:
 * 1. You want to modify request context (see Part 1).
 * 2. You want to create a new middleware or type of procedure (see Part 3).
 *
 * TL;DR - This is where all the tRPC server stuff is created and plugged in. The pieces you will
 * need to use are documented accordingly near the end.
 */

import type { AppAbility } from '@/ability'
import { db } from '@/db'
import { log } from '@/server/logger'
import { getServerAuthSession } from '@/server/auth'
import { initTRPC, TRPCError } from '@trpc/server'
import superjson from 'superjson'
import { ZodError } from 'zod'

export type Access =
	| { kind: 'public'; reason: string }
	| { kind: 'session' }
	| { kind: 'learner'; resource: string }
	| {
			kind: 'can'
			action: Parameters<AppAbility['can']>[0]
			subject: Extract<Parameters<AppAbility['can']>[1], string>
	  }

export type AccessMeta = { access: Access }

/** Check a loaded row (or its identity before fetching) against CASL. */
export function assertCan(
	ability: AppAbility,
	action: Parameters<AppAbility['can']>[0],
	subjectWithRow: Parameters<AppAbility['can']>[1],
): void {
	if (!ability.can(action, subjectWithRow)) {
		throw new TRPCError({ code: 'FORBIDDEN' })
	}
}

/**
 * 1. CONTEXT
 *
 * This section defines the "contexts" that are available in the backend API.
 *
 * These allow you to access things when processing a request, like the database, the session, etc.
 *
 * This helper generates the "internals" for a tRPC context. The API handler and RSC clients each
 * wrap this and provides the required context.
 *
 * @see https://trpc.io/docs/server/context
 */
export const createTRPCContext = async (opts: { headers: Headers }) => {
	// trpc passes headers here and into the context of each request

	const { session, ability } = await getServerAuthSession()

	return {
		db,
		session,
		ability,
		...opts,
	}
}

/**
 * 2. INITIALIZATION
 *
 * This is where the tRPC API is initialized, connecting the context and transformer. We also parse
 * ZodErrors so that you get typesafety on the frontend if your procedure fails due to validation
 * errors on the backend.
 */
const t = initTRPC
	.context<typeof createTRPCContext>()
	.meta<AccessMeta>()
	.create({
		transformer: superjson,
		errorFormatter({ shape, error }) {
			return {
				...shape,
				data: {
					...shape.data,
					zodError:
						error.cause instanceof ZodError ? error.cause.flatten() : null,
				},
			}
		},
	})

/**
 * 3. ROUTER & PROCEDURE (THE IMPORTANT BIT)
 *
 * These are the pieces you use to build your tRPC API. You should import these a lot in the
 * "/src/server/api/routers" directory.
 */

/**
 * This is how you create new routers and sub-routers in your tRPC API.
 *
 * @see https://trpc.io/docs/router
 */
export const createTRPCRouter = t.router

/**
 * Public (unauthenticated) procedure
 *
 * This is the base piece you use to build new queries and mutations on your tRPC API. It does not
 * guarantee that a user querying is authorized, but you can still access user session data if they
 * are logged in.
 */
/** @deprecated Use procedure builders. See the AI Hero default-deny plan, step 1 (report mode). */
export const publicProcedure = t.procedure

function declared(access: Access) {
	return t.procedure.meta({ access }).use(async ({ path, next }) => {
		const result = await next()
		if (
			!result.ok &&
			['UNAUTHORIZED', 'FORBIDDEN'].includes(result.error.code)
		) {
			await log.warn('access.denied', { procedure: path, kind: access.kind })
		}
		return result
	})
}

function authenticated(access: Exclude<Access, { kind: 'public' }>) {
	return declared(access).use(({ ctx, next }) => {
		if (!ctx.session?.user) throw new TRPCError({ code: 'UNAUTHORIZED' })
		if (
			access.kind === 'can' &&
			!ctx.ability.can(access.action, access.subject)
		) {
			throw new TRPCError({ code: 'FORBIDDEN' })
		}
		return next({
			ctx: { session: { ...ctx.session, user: ctx.session.user } },
		})
	})
}

// Output comes first: a resolver cannot be attached until a Zod schema is supplied.
function withRequiredOutput<T extends ReturnType<typeof declared>>(builder: T) {
	return { output: builder.output } as Pick<T, 'output'>
}

function can(
	action: Extract<Access, { kind: 'can' }>['action'],
	subject: Extract<Access, { kind: 'can' }>['subject'],
) {
	return authenticated({ kind: 'can', action, subject })
}

export const procedure = {
	public: ({ reason }: { reason: string }) =>
		withRequiredOutput(declared({ kind: 'public', reason })),
	session: () => withRequiredOutput(authenticated({ kind: 'session' })),
	learner: (resource: string) =>
		withRequiredOutput(authenticated({ kind: 'learner', resource })),
	can,
	editor: () => can('create', 'Content'),
	admin: () => can('manage', 'all'),
}

/**
 * Protected (authenticated) procedure
 *
 * If you want a query or mutation to ONLY be accessible to logged in users, use this. It verifies
 * the session is valid and guarantees `ctx.session.user` is not null.
 *
 * @see https://trpc.io/docs/procedures
 */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
	if (!ctx.session || !ctx.session.user) {
		throw new TRPCError({ code: 'UNAUTHORIZED' })
	}
	return next({
		ctx: {
			// infers the `session` as non-nullable
			session: { ...ctx.session, user: ctx.session.user },
		},
	})
})
