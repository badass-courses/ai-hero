import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import LayoutClient from '@/components/layout-client'
import { getCohort } from '@/lib/cohorts-query'
import { getServerAuthSession } from '@/server/auth'

import { EditCohortClient } from './edit-cohort-client'

export const dynamic = 'force-dynamic'

const toIso = (value: unknown) =>
	value instanceof Date ? value.toISOString() : value

export default async function CohortEditPage(props: {
	params: Promise<{ slug: string }>
}) {
	const params = await props.params
	await headers()
	const { ability } = await getServerAuthSession()
	const cohort = await getCohort(params.slug)

	if (!cohort || !ability.can('create', 'Content')) {
		notFound()
	}

	// Serialize Date instances (createdAt/updatedAt from the DB driver) to ISO
	// strings before crossing the RSC boundary — Next's serialization warning
	// flags them on the `cohort` prop, and the editor's changed-indicator
	// accepts strings and Dates alike.
	const clientCohort = {
		...cohort,
		createdAt: toIso(cohort.createdAt),
		updatedAt: toIso(cohort.updatedAt),
		deletedAt: toIso(cohort.deletedAt),
	} as typeof cohort

	return (
		<LayoutClient withFooter={false}>
			<EditCohortClient key={cohort.fields.slug} cohort={clientCohort} />
		</LayoutClient>
	)
}
