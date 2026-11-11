import { db } from '@/db'
import { accounts, users } from '@/db/schema'
import { getIncomingTransfer } from '@/lib/incoming-transfers'
import {
	getPlaybackPrefsForUser,
	setPlaybackPrefsForUser,
} from '@/lib/playback-prefs-query'
import {
	createTRPCRouter,
	protectedProcedure,
	procedure,
	assertCan,
} from '@/trpc/api/trpc'
import { TRPCError } from '@trpc/server'
import { subject } from '@casl/ability'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

import { isEmpty } from '@coursebuilder/nodash'

export const usersRouter = createTRPCRouter({
	// A user row carries the email address: only that user or an admin may read it (sec-20261111-007).
	get: procedure
		.learner('User')
		.output(
			z
				.object({
					id: z.string(),
					name: z.string().nullable(),
					email: z.string().nullable(),
					image: z.string().nullable(),
					role: z.string().nullable(),
				})
				.optional(),
		)
		.input(
			z.object({
				userId: z.string(),
			}),
		)
		.query(async ({ ctx, input }) => {
			// Check identity before fetching, so forbidden and missing ids are indistinguishable.
			assertCan(ctx.ability, 'read', subject('User', { id: input.userId }))
			return await db.query.users.findFirst({
				where: (users, { eq }) => eq(users.id, input.userId),
			})
		}),

	githubConnected: procedure
		.session()
		.output(z.boolean())
		.query(async ({ ctx }) => {
			const userAccounts = await db.query.accounts.findMany({
				where: and(
					eq(accounts.userId, ctx.session.user.id),
					eq(accounts.provider, 'github'),
				),
			})

			return !isEmpty(userAccounts)
		}),
	updateName: procedure
		.session()
		.output(z.object({ name: z.string() }))
		.input(
			z.object({
				name: z.string(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				await db
					.update(users)
					.set({ name: input.name })
					.where(eq(users.id, ctx.session.user.id))
			} catch (e) {
				throw new TRPCError({
					message: 'Failed to update name',
					code: 'INTERNAL_SERVER_ERROR',
				})
			}

			return { name: input.name }
		}),
	/** A seat sent to this user that is still waiting, for the site reminder. */
	incomingTransfer: protectedProcedure.query(async ({ ctx }) => {
		return getIncomingTransfer(ctx.session.user.id)
	}),
	getPlaybackPrefs: protectedProcedure.query(async ({ ctx }) => {
		return getPlaybackPrefsForUser(ctx.session.user.id)
	}),
	setPlaybackPrefs: protectedProcedure
		.input(
			z.object({
				allowLowResolution: z.boolean(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			return setPlaybackPrefsForUser(ctx.session.user.id, {
				allowLowResolution: input.allowLowResolution,
			})
		}),
})
