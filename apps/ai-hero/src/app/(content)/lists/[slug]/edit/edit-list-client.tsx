'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { createListBindings } from '@/lib/cms/list-bindings'
import { ListSchema, type List } from '@/lib/lists'
import type { Tag } from '@/lib/tags'
import { getResourcePath } from '@coursebuilder/utils/resource-paths'

import { createResourceEditor, listManifest } from '@coursebuilder/ui/cms'
import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
	Label,
	Textarea,
} from '@coursebuilder/ui'

export type EditListClientProps = {
	list: List
	/** Full tag vocabulary, server-fetched by the page (`getTags`). */
	tags: Tag[]
}

/**
 * Client wrapper for the cms list editor (mirrors `EditPostClient`). The
 * editor component is created once per mount — NOT per render, the legacy
 * `withResourceForm`-inside-render flaw — via useMemo; the page keys this
 * component by slug so a slug change remounts with fresh data.
 */
export function EditListClient({ list, tags }: EditListClientProps) {
	const router = useRouter()

	// Imperative bridge: the kit's "+ New section" calls the async create
	// binding, which awaits promptSectionTitle() below. We open a controlled
	// dialog and resolve the pending promise when the user submits or cancels.
	type SectionDetails = { title: string; description?: string }
	const [sectionDialogOpen, setSectionDialogOpen] = React.useState(false)
	const [sectionTitle, setSectionTitle] = React.useState('')
	const [sectionDescription, setSectionDescription] = React.useState('')
	const pendingResolveRef = React.useRef<
		((details: SectionDetails | null) => void) | null
	>(null)

	const settleSectionPrompt = React.useCallback(
		(details: SectionDetails | null) => {
			const resolve = pendingResolveRef.current
			pendingResolveRef.current = null
			setSectionDialogOpen(false)
			resolve?.(details)
		},
		[],
	)

	const promptSectionTitle = React.useCallback(() => {
		return new Promise<SectionDetails | null>((resolve) => {
			// Guard against a stray open prompt — cancel it before replacing.
			pendingResolveRef.current?.(null)
			pendingResolveRef.current = resolve
			setSectionTitle('')
			setSectionDescription('')
			setSectionDialogOpen(true)
		})
	}, [])

	const ListEditor = React.useMemo(() => {
		return createResourceEditor({
			manifest: {
				...listManifest,
				schema: ListSchema,
			},
			bindings: createListBindings({
				availableTags: tags.map((tag) => ({
					id: tag.id,
					label: tag.fields.label,
				})),
				onSlugChange: (slug) => router.push(`/lists/${slug}/edit`),
				// Resources tab per-row ⋯ Edit → the child's edit route (the app's
				// canonical type→route map; posts resolve to /posts/{slug}/edit).
				onEditItem: (item) =>
					router.push(
						getResourcePath(item.type, item.slug ?? item.id, 'edit', {
							parentType: 'list',
							parentSlug: list.fields.slug,
						}),
					),
				// Per-row external-link icon → the child's public (view) URL.
				getItemHref: (item) =>
					item.slug
						? getResourcePath(item.type, item.slug, 'view', {
								parentType: 'list',
								parentSlug: list.fields.slug,
							})
						: undefined,
				// Name a section before it's created (sections have no edit route).
				promptSectionTitle,
			}),
		})
		// Stable per mount by design; the page's key={slug} handles data changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	const trimmedTitle = sectionTitle.trim()

	return (
		<>
			<ListEditor
				resource={list}
				// The shell defaults to h-dvh ("the shell IS the page"); subtract the
				// app nav it renders under.
				className="h-[calc(100dvh-var(--nav-height))]"
			/>
			<Dialog
				open={sectionDialogOpen}
				onOpenChange={(open) => {
					// Closing via overlay/escape resolves the pending prompt as cancel.
					if (!open) settleSectionPrompt(null)
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>New section</DialogTitle>
					</DialogHeader>
					<form
						onSubmit={(event) => {
							event.preventDefault()
							if (trimmedTitle) {
								settleSectionPrompt({
									title: trimmedTitle,
									description: sectionDescription.trim() || undefined,
								})
							}
						}}
						className="flex flex-col gap-4"
					>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="section-title">Title</Label>
							<Input
								id="section-title"
								autoFocus
								value={sectionTitle}
								onChange={(event) => setSectionTitle(event.target.value)}
								placeholder="Section title"
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="section-description">
								Description{' '}
								<span className="text-muted-foreground font-normal">
									(optional)
								</span>
							</Label>
							<Textarea
								id="section-description"
								value={sectionDescription}
								onChange={(event) => setSectionDescription(event.target.value)}
								placeholder="What this section covers"
								rows={3}
							/>
						</div>
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => settleSectionPrompt(null)}
							>
								Cancel
							</Button>
							<Button type="submit" disabled={!trimmedTitle}>
								Create section
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	)
}
