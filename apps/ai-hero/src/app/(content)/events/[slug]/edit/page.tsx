import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import LayoutClient from '@/components/layout-client'
import { getEventOrEventSeries } from '@/lib/events-query'
import type { Event } from '@/lib/events'
import { getTags } from '@/lib/tags-query'
import { getServerAuthSession } from '@/server/auth'

import { EditEventClient } from './edit-event-client'

export const dynamic = 'force-dynamic'

const toIso = (value: unknown) =>
	value instanceof Date ? value.toISOString() : value

type Props = {
	params: Promise<{ slug: string }>
	searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}

const firstParam = (value: string | string[] | undefined) =>
	Array.isArray(value) ? value[0] : value

export default async function EventEditPage(props: Props) {
	const params = await props.params
	const searchParams = await props.searchParams
	await headers()
	const { ability } = await getServerAuthSession()
	// getEventOrEventSeries instead of the legacy getEvent so the row arrives
	// WITH its tags (getEvent never loaded them — the editor's tag chips need
	// the seed). The type guard preserves the legacy behavior exactly:
	// event-series has NO edit route (getEvent returned null for series).
	const resource = await getEventOrEventSeries(params.slug)

	if (
		!resource ||
		resource.type !== 'event' ||
		!ability.can('create', 'Content')
	) {
		notFound()
	}
	const event = resource as Event

	// Tag vocabulary for the editor's tag combobox (immediate entity writes).
	const tags = await getTags()

	// Serialize Date instances (createdAt/updatedAt from the DB driver) to ISO
	// strings before crossing the RSC boundary — Next's serialization warning
	// flags them on the `event` prop, and the editor's changed-indicator
	// accepts strings and Dates alike.
	const clientEvent = {
		...event,
		createdAt: toIso(event.createdAt),
		updatedAt: toIso(event.updatedAt),
		deletedAt: toIso(event.deletedAt),
	} as typeof event

	return (
		<LayoutClient withFooter={false}>
			<EditEventClient
				key={event.fields.slug}
				event={clientEvent}
				tags={tags}
				// Seed the editor's tab/panel from the URL server-side so SSR
				// renders the same tab the client will (no hydration mismatch).
				initialTab={firstParam(searchParams.tab)}
				initialPanel={firstParam(searchParams.panel)}
			/>
		</LayoutClient>
	)
}
