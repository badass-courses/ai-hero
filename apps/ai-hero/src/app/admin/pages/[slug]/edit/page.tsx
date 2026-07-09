import * as React from 'react'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { getPage } from '@/lib/pages-query'
import { getServerAuthSession } from '@/server/auth'

import { EditPageClient } from './edit-page-client'

export const dynamic = 'force-dynamic'

const toIso = (value: unknown) =>
	value instanceof Date ? value.toISOString() : value

type Props = {
	params: Promise<{ slug: string }>
	searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}

const firstParam = (value: string | string[] | undefined) =>
	Array.isArray(value) ? value[0] : value

export default async function ArticleEditPage(props: Props) {
	const params = await props.params
	const searchParams = await props.searchParams
	await headers()
	const { ability } = await getServerAuthSession()
	const page = await getPage(params.slug)

	if (!page || !ability.can('create', 'Content')) {
		notFound()
	}

	// Serialize Date instances (createdAt/updatedAt from the DB driver) to ISO
	// strings before crossing the RSC boundary — same toIso pattern as the post
	// edit page; the editor's changed-indicator accepts strings and Dates alike.
	const clientPage = {
		...page,
		createdAt: toIso(page.createdAt),
		updatedAt: toIso(page.updatedAt),
		deletedAt: toIso(page.deletedAt),
	} as typeof page

	// No LayoutClient here — the admin layout (`app/admin/layout.tsx`) already
	// wraps children in LayoutClient plus the admin sidebar; the editor fills
	// the layout's content column.
	return (
		<EditPageClient
			key={page.fields.slug}
			page={clientPage}
			// Seed the editor's tab/panel from the URL server-side so SSR renders
			// the same tab the client will (no hydration mismatch).
			initialTab={firstParam(searchParams.tab)}
			initialPanel={firstParam(searchParams.panel)}
		/>
	)
}
