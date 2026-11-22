'use server'

import { getServerAuthSession } from '@/server/auth'
import { canCreateShortlink } from '@/server/pat-scopes'

import {
	createShortlink,
	deleteShortlink,
	getOrCreateShortlinkForPage,
	isSlugAvailable,
	updateShortlink,
} from './shortlinks-query'
import type {
	CreateShortlinkInput,
	Shortlink,
	UpdateShortlinkInput,
} from './shortlinks-types'

/**
 * The only shortlink functions a browser can call. Each takes its auth from
 * the session and nothing else: no ability, no user id, no extra argument.
 * shortlinks-query.ts used to be the action module itself, and its functions
 * trusted a caller-supplied auth argument, so anyone could pass one and mint,
 * repoint or delete aihero.dev shortlinks (security desk sec-047). That module
 * is now server-only and keeps the trusted-auth form for the REST route.
 */
async function sessionAuth() {
	const { ability, session } = await getServerAuthSession()
	return { ability, userId: session?.user?.id ?? null }
}

export async function createShortlinkAction(
	input: CreateShortlinkInput,
): Promise<Shortlink> {
	return createShortlink(input, await sessionAuth())
}

export async function updateShortlinkAction(
	input: UpdateShortlinkInput,
): Promise<Shortlink> {
	return updateShortlink(input, await sessionAuth())
}

export async function deleteShortlinkAction(id: string): Promise<void> {
	if (typeof id !== 'string') throw new Error('Invalid shortlink id')
	return deleteShortlink(id, await sessionAuth())
}

export async function getOrCreateShortlinkForPageAction(input: {
	url: string
	slug?: string
}): Promise<Shortlink> {
	const url = typeof input?.url === 'string' ? input.url : ''
	const slug = typeof input?.slug === 'string' ? input.slug : undefined
	return getOrCreateShortlinkForPage({ url, slug }, await sessionAuth())
}

export async function isSlugAvailableAction(slug: string): Promise<boolean> {
	const { ability } = await sessionAuth()
	if (!canCreateShortlink(ability)) throw new Error('Unauthorized')
	if (typeof slug !== 'string') return false
	return isSlugAvailable(slug)
}
