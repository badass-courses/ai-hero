import { db } from '@/db'
import { accounts, users } from '@/db/schema'
import { getIncomingTransfer } from '@/lib/incoming-transfers'
import {
	getPlaybackPrefsForUser,
	setPlaybackPrefsForUser,
} from '@/lib/playback-prefs-query'
import { getServerAuthSession } from '@/server/auth'
import {
	createTRPCRouter,
	protectedProcedure,
	publicProcedure,
} from '@/trpc/api/trpc'
import { TRPCError } from '@trpc/server'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

import { isEmpty } from '@coursebuilder/nodash'

export const usersRouter = createTRPCRouter({
	get: publicProcedure
		.input(
			z.object({
				userId: z.string(),
			}),
		)
		.query(async ({ ctx, input }) => {
			return await db.query.users.findFirst({
				where: (users, { eq }) => eq(users.id, input.userId),
			})
		}),

	githubConnected: publicProcedure.query(async ({ ctx, input }) => {
		const token = await getServerAuthSession()
		if (!token.session?.user) return false

		const userAccounts = await db.query.accounts.findMany({
			where: and(
				eq(accounts.userId, token.session.user.id),
				eq(accounts.provider, 'github'),
			),
		})

		return !isEmpty(userAccounts)
	}),
	updateName: publicProcedure
		.input(
			z.object({
				name: z.string(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const token = await getServerAuthSession()
			if (!token.session?.user)
				throw new TRPCError({
					message: 'Not authenticated',
					code: 'UNAUTHORIZED',
				})

			try {
				await db
					.update(users)
					.set({ name: input.name })
					.where(eq(users.id, token.session.user.id))
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
