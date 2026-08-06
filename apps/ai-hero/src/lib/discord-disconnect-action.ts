'use server'

import { db } from '@/db'
import { accounts, users } from '@/db/schema'
import { getServerAuthSession } from '@/server/auth'
import { and, eq } from 'drizzle-orm'

import { isEmpty } from '@coursebuilder/nodash'

export async function disconnectDiscord() {
	const { session } = await getServerAuthSession()
	if (!session?.user) return false

	const user = await db.query.users.findFirst({
		where: eq(users.id, session.user.id),
		with: {
			accounts: {
				where: eq(accounts.provider, 'discord'),
			},
		},
	})

	if (isEmpty(user?.accounts) || !user) return false

	await db
		.delete(accounts)
		.where(and(eq(accounts.provider, 'discord'), eq(accounts.userId, user.id)))

	return true
}
