import type { Metadata, ResolvingMetadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import LayoutClient from '@/components/layout-client'
import { getList } from '@/lib/lists-query'
import { getTags } from '@/lib/tags-query'
import { getServerAuthSession } from '@/server/auth'
import { subject } from '@casl/ability'

import { EditListClient } from './edit-list-client'

export const dynamic = 'force-dynamic'

const toIso = (value: unknown) =>
	value instanceof Date ? value.toISOString() : value

type Props = {
	params: Promise<{ slug: string }>
	searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}

export async function generateMetadata(
	props: Props,
	parent: ResolvingMetadata,
): Promise<Metadata> {
	const params = await props.params
	const list = await getList(params.slug)

	if (!list) {
		return parent as Metadata
	}

	return {
		title: `📝 ${list.fields.title}`,
	}
}

const firstParam = (value: string | string[] | undefined) =>
	Array.isArray(value) ? value[0] : value

export default async function ListEditPage(props: Props) {
	const params = await props.params
	const searchParams = await props.searchParams
	const { ability } = await getServerAuthSession()
	const list = await getList(params.slug)

	if (!list || !ability.can('create', 'Content')) {
		notFound()
	}

	if (ability.cannot('manage', subject('Content', list))) {
		redirect(`/${list?.fields?.slug}`)
	}

	// Tag vocabulary for the editor's tag combobox (immediate entity writes).
	const tags = await getTags()

	// Serialize Date instances (createdAt/updatedAt from the DB driver) to ISO
	// strings before crossing the RSC boundary — same toIso pattern as the post
	// edit page; the editor's changed-indicator accepts strings and Dates alike.
	const clientList = {
		...list,
		createdAt: toIso(list.createdAt),
		updatedAt: toIso(list.updatedAt),
		deletedAt: toIso(list.deletedAt),
	} as typeof list

	return (
		<LayoutClient withFooter={false}>
			<EditListClient
				key={list.fields.slug}
				list={clientList}
				tags={tags}
				// Seed the editor's tab/panel from the URL server-side so SSR
				// renders the same tab the client will (no hydration mismatch).
				initialTab={firstParam(searchParams.tab)}
				initialPanel={firstParam(searchParams.panel)}
			/>
		</LayoutClient>
	)
}
