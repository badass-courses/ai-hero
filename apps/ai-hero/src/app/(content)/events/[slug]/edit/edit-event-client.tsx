'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { createEventBindings } from '@/lib/cms/event-bindings'
import { EventSchema, type Event } from '@/lib/events'
import type { Tag } from '@/lib/tags'

import { createResourceEditor, eventManifest } from '@coursebuilder/ui/cms'

export type EditEventClientProps = {
	event: Event
	/** Full tag vocabulary, server-fetched by the page (`getTags`). */
	tags: Tag[]
}

/**
 * Normalization for the form's default values — ''/undefined fallbacks so
 * inputs stay controlled (ports the legacy `EditEventForm` defaultValues,
 * which becomes unreferenced with this cutover). Dates arrive as ISO strings
 * (schema-validated); timezone keeps the legacy LA default.
 */
function eventDefaultValues(resource: unknown) {
	const event = resource as Event
	return {
		...event,
		fields: {
			...event?.fields,
			title: event?.fields?.title ?? '',
			slug: event?.fields?.slug ?? '',
			description: event?.fields?.description ?? '',
			details: event?.fields?.details ?? '',
			body: event?.fields?.body ?? '',
			image: event?.fields?.image ?? '',
			location: event?.fields?.location ?? '',
			attendeeInstructions: event?.fields?.attendeeInstructions ?? '',
			timezone: event?.fields?.timezone || 'America/Los_Angeles',
			state: event?.fields?.state ?? 'draft',
			visibility: event?.fields?.visibility ?? 'public',
			startsAt: event?.fields?.startsAt
				? new Date(event.fields.startsAt).toISOString()
				: undefined,
			endsAt: event?.fields?.endsAt
				? new Date(event.fields.endsAt).toISOString()
				: undefined,
		},
	}
}

/**
 * Client wrapper for the cms event editor. The editor component is created
 * once per mount (NOT per render — a per-render `createResourceEditor` would
 * remount the whole form on every keystroke). Module scope isn't possible
 * because the tag vocabulary and the router (slug-change redirect) are
 * per-request; the page keys this component by slug, so a slug change
 * remounts with fresh data.
 */
export function EditEventClient({ event, tags }: EditEventClientProps) {
	const router = useRouter()

	const EventEditor = React.useMemo(() => {
		return createResourceEditor({
			manifest: {
				...eventManifest,
				schema: EventSchema,
				defaultValues: eventDefaultValues,
			},
			bindings: createEventBindings({
				availableTags: tags.map((tag) => ({
					id: tag.id,
					label: tag.fields.label,
				})),
				onSlugChange: (slug) => router.push(`/events/${slug}/edit`),
			}),
		})
		// Stable per mount by design; the page's key={slug} handles data changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	return (
		<EventEditor
			resource={event}
			// The shell defaults to h-dvh ("the shell IS the page"); subtract the
			// app nav it renders under.
			className="h-[calc(100dvh-var(--nav-height))]"
		/>
	)
}
