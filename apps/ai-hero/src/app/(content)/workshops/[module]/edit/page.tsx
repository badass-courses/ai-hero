import * as React from 'react'
import type { Metadata, ResolvingMetadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import LayoutClient from '@/components/layout-client'
import { getCachedMinimalWorkshop, getWorkshop } from '@/lib/workshops-query'
import { getServerAuthSession } from '@/server/auth'

import { EditWorkshopClient } from './edit-workshop-client'

export const dynamic = 'force-dynamic'

const toIso = (value: unknown) =>
	value instanceof Date ? value.toISOString() : value

export async function generateMetadata(
	props: {
		params: Promise<{ module: string }>
	},
	parent: ResolvingMetadata,
): Promise<Metadata> {
	const params = await props.params
	const workshop = await getCachedMinimalWorkshop(params.module)

	if (!workshop) {
		return parent as Metadata
	}

	return {
		title: `Edit ${workshop.fields?.title}`,
	}
}

export default async function EditWorkshopPage(props: {
	params: Promise<{ module: string }>
}) {
	const params = await props.params
	const { ability } = await getServerAuthSession()

	if (!ability.can('update', 'Content')) {
		redirect('/login')
	}

	const workshop = await getWorkshop(params.module)

	if (!workshop) {
		notFound()
	}

	// Serialize Date instances (createdAt/updatedAt from the DB driver) to ISO
	// strings before crossing the RSC boundary — same toIso pattern as the post
	// edit page; the editor's changed-indicator accepts strings and Dates alike.
	const clientWorkshop = {
		...workshop,
		createdAt: toIso(workshop.createdAt),
		updatedAt: toIso(workshop.updatedAt),
		deletedAt: toIso(workshop.deletedAt),
	} as typeof workshop

	return (
		<LayoutClient withFooter={false}>
			<EditWorkshopClient
				key={workshop.fields.slug}
				workshop={clientWorkshop}
			/>
		</LayoutClient>
	)
}
