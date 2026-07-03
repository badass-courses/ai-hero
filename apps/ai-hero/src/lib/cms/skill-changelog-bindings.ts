import { getResourceParents } from '@/lib/resources-query'
import type {
	SkillChangelog,
	SkillChangelogSchema,
	SkillChangelogUpdate,
} from '@/lib/skill-changelog'
import { updateSkillChangelog } from '@/lib/skill-changelog-mutations'

import type {
	ResourceAction,
	ResourceBindings,
} from '@coursebuilder/ui/cms/manifest'

import {
	createVideoLibraryBinding,
	listImageMediaAssets,
	listVideoPickerItems,
	uploadToCloudinary,
	uploadVideoMedia,
} from './post-bindings'

/**
 * Server bindings for the cms skill-changelog editor
 * (`createResourceEditor`).
 *
 * Mirrors `createPostBindings`. Saves go through `updateSkillChangelog` —
 * the ONE legacy mutation with the modern action-aware signature
 * (`save | publish | unpublish | archive`), which matches the kit's
 * `ResourceAction` verbs 1:1 (per-action CASL checks, TypeSense sync, and the
 * draft→published Inngest broadcast all preserved). The update payload is the
 * exact field mapping `skillChangelogFormConfig.updateResource` built —
 * notably the kitBroadcast* bookkeeping fields are NEVER sent
 * (SkillChangelogUpdateSchema excludes them so client saves can't clobber
 * them).
 *
 * NOTE the legacy autosave path (`autoUpdateSkillChangelog`) has no kit
 * equivalent — the cms editor is explicit-save only (Cmd+S / action bar).
 */
export interface CreateSkillChangelogBindingsOptions {
	/**
	 * Called after a save whose slug differs from the last-saved slug.
	 * Parity with the legacy form: redirect to the new edit URL.
	 */
	onSlugChange?: (slug: string) => void
}

/**
 * The editor sets `fields.state` before submitting, but derive it from the
 * action anyway so the persisted state can never disagree with the verb.
 */
function stateForAction(
	action: ResourceAction,
	current: SkillChangelog['fields']['state'],
): SkillChangelog['fields']['state'] {
	switch (action) {
		case 'publish':
			return 'published'
		case 'archive':
			return 'archived'
		case 'unpublish':
			return 'draft'
		default:
			return current
	}
}

export function createSkillChangelogBindings({
	onSlugChange,
}: CreateSkillChangelogBindingsOptions = {}): ResourceBindings<
	typeof SkillChangelogSchema
> {
	return {
		update: async (values, action) => {
			if (!values.id || !values.fields) {
				throw new Error('Invalid skill changelog data')
			}
			const update: SkillChangelogUpdate = {
				id: values.id,
				fields: {
					title: values.fields.title || '',
					slug: values.fields.slug || '',
					body: values.fields.body ?? '',
					description: values.fields.description ?? '',
					state: stateForAction(action, values.fields.state || 'draft'),
					visibility: values.fields.visibility || 'unlisted',
					github: values.fields.github ?? '',
					thumbnailTime: values.fields.thumbnailTime ?? 0,
					// Persist null (not `{ url: '' }`, and not a stripped key — the
					// server merges fields per-key, so omitting would keep the old
					// image forever) so clearing the cover image actually clears it.
					coverImage: values.fields.coverImage?.url
						? values.fields.coverImage
						: null,
					newsletterSubject: values.fields.newsletterSubject ?? null,
					newsletterPreviewText: values.fields.newsletterPreviewText ?? null,
					newsletterCopy: values.fields.newsletterCopy ?? null,
				},
			}
			const updated = await updateSkillChangelog(update, action)
			// null here means nothing was persisted — don't let the kit report 'Saved'.
			if (updated == null) {
				throw new Error('Changelog save failed — nothing was persisted')
			}
			return updated
		},
		onSave: async (resource, hasNewSlug) => {
			const slug = resource?.fields?.slug
			if (hasNewSlug && slug) {
				onSlugChange?.(slug)
			}
		},
		getResourcePath: (slug) => `/skills/${slug || ''}`,
		getParents: (id) => getResourceParents(id),
		media: {
			// The legacy uploadDirectory — skill-changelog had it right (unlike
			// email/page, which uploaded to 'workshops').
			upload: (file) => uploadToCloudinary(file, 'skill-changelog'),
			// The app's DB-backed image library (`imageResource` rows).
			list: listImageMediaAssets,
			// Kit-driven video upload (uploadthing → Inngest pipeline) — pairs
			// with `listVideos` to make the Media tab a full video surface.
			uploadVideo: uploadVideoMedia,
		},
		// Body editor "Video…" insert — the same library the Video tab lists.
		listVideos: listVideoPickerItems,
		// Media-tab video verbs: preview player + transcript + reprocess.
		videoLibrary: createVideoLibraryBinding(),
	}
}
