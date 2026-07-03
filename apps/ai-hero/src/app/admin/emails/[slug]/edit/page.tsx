import * as React from 'react'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { getEmail } from '@/lib/emails-query'
import { getServerAuthSession } from '@/server/auth'

import { EditEmailClient } from './edit-email-client'

export const dynamic = 'force-dynamic'

const toIso = (value: unknown) =>
	value instanceof Date ? value.toISOString() : value

export default async function ArticleEditEmail(props: {
	params: Promise<{ slug: string }>
}) {
	const params = await props.params
	await headers()
	const { ability } = await getServerAuthSession()
	const email = await getEmail(params.slug)

	if (!email || !ability.can('create', 'Content')) {
		notFound()
	}

	// Serialize Date instances (createdAt/updatedAt from the DB driver) to ISO
	// strings before crossing the RSC boundary — same toIso pattern as the post
	// edit page; the editor's changed-indicator accepts strings and Dates alike.
	// NOTE: no LayoutClient here — the /admin layout already wraps this route
	// in LayoutClient + the admin sidebar grid.
	const clientEmail = {
		...email,
		createdAt: toIso(email.createdAt),
		updatedAt: toIso(email.updatedAt),
		deletedAt: toIso(email.deletedAt),
	} as typeof email

	return <EditEmailClient key={email.fields.slug} email={clientEmail} />
}
