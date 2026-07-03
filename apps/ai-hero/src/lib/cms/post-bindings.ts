import { env } from '@/env.mjs'
import {
	createImageResource,
	getAllImageResources,
} from '@/lib/image-resource-query'
import { addPostToList, removePostFromList } from '@/lib/lists-query'
import type { Post, PostSchema, PostUpdate } from '@/lib/posts'
import { addTagToPost, removeTagFromPost, updatePost } from '@/lib/posts-query'
import {
	getResourceParents,
	listResourcesForPicker,
	listVideoResourcesForPicker,
} from '@/lib/resources-query'
import { type OurFileRouter } from '@/uploadthing/core'
import {
	attachVideoResourceToPost,
	getVideoResource,
} from '@/lib/video-resource-query'
import { reprocessTranscript } from '@/app/(content)/posts/[slug]/edit/actions'
import { genUploader } from 'uploadthing/client'

import type { TagOption } from '@coursebuilder/ui/cms/fields/tag-field'
import type {
	ListMembership,
	MediaAsset,
	MediaUploadResult,
	PickerItem,
	ResourceAction,
	ResourceBindings,
	VideoDetail,
	VideoLibraryBinding,
	VideoUploadResult,
} from '@coursebuilder/ui/cms/manifest'
import { createCloudinaryUpload } from '@coursebuilder/ui/cms/media-upload'
import { getUniqueFilename } from '@coursebuilder/utils/get-unique-filename'

/**
 * Server bindings for the cms post editor (`createResourceEditor`).
 *
 * A factory rather than a constant because several pieces are per-request:
 * the post id (Cloudinary upload dir), the tag vocabulary and list
 * memberships (fetched server-side by the edit page), and the slug-change
 * redirect (needs the app router). Everything else maps 1:1 onto the server
 * actions the legacy `postFormConfig` used.
 */
export interface CreatePostBindingsOptions {
	/** The post's id — scopes Cloudinary uploads to `posts/{id}` (legacy dir). */
	resourceId: string
	/** Full tag vocabulary for the add-combobox (server-fetched via `getTags`). */
	availableTags: TagOption[]
	/**
	 * Lists the post currently belongs to, server-fetched by the edit page
	 * (`getPostLists`). The editor keeps membership state optimistically from
	 * this seed; add/remove persist immediately (the tags precedent).
	 */
	listMemberships: ListMembership[]
	/**
	 * Called after a save whose slug differs from the last-saved slug.
	 * Parity with the legacy form: redirect to the new edit URL; a save with
	 * an unchanged slug stays put.
	 */
	onSlugChange?: (slug: string) => void
}

/**
 * Direct unsigned upload to Cloudinary — the REST equivalent of the legacy
 * upload widget (`CloudinaryUploadButton`): same cloud, same unsigned preset,
 * same per-type folder (`posts/{postId}`). Runs in the browser (the media tab
 * is a client surface), exactly like the widget did. Images are registered as
 * `imageResource` rows via `createImageResource` — the same server action the
 * widget callback used — so they show up in the media library list.
 *
 * Exported for reuse by other resource types' bindings (product uses the same
 * pipeline with its own upload folder).
 */
export async function uploadToCloudinary(
	file: File,
	folder: string,
): Promise<MediaUploadResult> {
	// The fetch/FormData dance lives in the kit (`createCloudinaryUpload`);
	// this app supplies only its public env keys, the folder, and the
	// post-upload hook. Only images become library rows (type 'imageResource');
	// other kinds stay Cloudinary-only but still return a usable URL for this
	// session.
	return createCloudinaryUpload({
		cloudName: env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME,
		uploadPreset: env.NEXT_PUBLIC_CLOUDINARY_UPLOAD_PRESET,
		folder,
		onUploaded: (info) =>
			info.resource_type === 'image'
				? createImageResource({
						asset_id: info.asset_id,
						secure_url: info.secure_url,
						width: info.width,
						height: info.height,
						bytes: info.bytes,
						format: info.format,
					})
				: undefined,
	})(file)
}

/**
 * The shared `media.uploadVideo` binding: the SAME uploadthing `videoUploader`
 * endpoint the legacy PostUploader dropzone used, as a plain async function
 * the kit can drive (the kit owns the button/progress/optimistic tile UI).
 * Server-side completion fires the Inngest VIDEO_UPLOADED_EVENT, which creates
 * the videoResource with the unique fileName as its id — so the returned
 * `videoResourceId` is valid for `<Video resourceId="…" />` immediately, while
 * processing continues in the background. Exported for every resource type's
 * bindings (like `listVideoPickerItems`).
 */
const { uploadFiles } = genUploader<OurFileRouter>({ package: 'ai-hero' })

export async function uploadVideoMedia(
	file: File,
	opts?: { onProgress?: (percent: number) => void },
): Promise<VideoUploadResult> {
	// Unique filename BEFORE upload — same trick as PostUploader's
	// onBeforeUploadBegin; the pipeline reuses it as the videoResource id.
	const fileName = getUniqueFilename(file.name)
	const renamed = new File([file], fileName, { type: file.type })
	const uploaded = await uploadFiles('videoUploader', {
		files: [renamed],
		input: {},
		onUploadProgress: ({ progress }) => opts?.onProgress?.(progress),
	})
	const result = uploaded[0]
	if (!result) throw new Error('Video upload failed')
	return { videoResourceId: result.name, fileName: result.name }
}

/**
 * The shared `videoLibrary.get` binding: one video's detail for the Media
 * tab's preview dialog — real playback (muxPlaybackId → the kit's Mux
 * player), transcript, and lifecycle state. Exported for every resource
 * type's bindings.
 */
export async function getVideoMediaDetail(
	videoResourceId: string,
): Promise<VideoDetail | null> {
	const video = await getVideoResource(videoResourceId)
	if (!video) return null
	return {
		id: video.id,
		state: video.state,
		muxPlaybackId: video.muxPlaybackId,
		title: video.title,
		duration: video.duration,
		transcript: video.transcript,
	}
}

/** The shared `videoLibrary.reprocessTranscript` binding (Inngest re-order). */
export async function reprocessVideoTranscript(
	videoResourceId: string,
): Promise<void> {
	await reprocessTranscript({ videoResourceId })
}

/**
 * Build the Media tab's `videoLibrary` binding. `primaryResourceId` (types
 * that accept a primary video: post) adds "Set as primary" — the attach
 * replaces any existing primary video join row.
 */
export function createVideoLibraryBinding(opts?: {
	primaryResourceId?: string
}): VideoLibraryBinding {
	const primaryResourceId = opts?.primaryResourceId
	return {
		get: getVideoMediaDetail,
		reprocessTranscript: reprocessVideoTranscript,
		...(primaryResourceId
			? {
					setPrimaryVideo: async (videoResourceId: string) => {
						const ok = await attachVideoResourceToPost(
							primaryResourceId,
							videoResourceId,
						)
						if (!ok) throw new Error('Failed to set the primary video')
					},
				}
			: {}),
	}
}

/**
 * The shared media `list` binding: the app's DB-backed image library
 * (`imageResource` rows) mapped to kit MediaAssets, carrying the Cloudinary
 * metadata (width/height/bytes/format) stored at upload time — rows created
 * before that was stored simply omit it (the kit measures client-side).
 * Exported for every resource type's bindings.
 */
export async function listImageMediaAssets(): Promise<MediaAsset[]> {
	const images = await getAllImageResources()
	return images.map(
		(image): MediaAsset => ({
			url: image.url,
			name: image.alt ?? undefined,
			kind: 'image',
			// The media tab's unified grid sorts by this (created-at, newest first).
			createdAt: image.createdAt ?? undefined,
			width: image.width ?? undefined,
			height: image.height ?? undefined,
			bytes: image.bytes ?? undefined,
			format: image.format ?? undefined,
		}),
	)
}

/** Seconds → 'm:ss' / 'h:mm:ss' for the video picker's secondary column. */
function formatDuration(seconds: number | null): string | undefined {
	if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) {
		return undefined
	}
	const total = Math.round(seconds)
	const h = Math.floor(total / 3600)
	const m = Math.floor((total % 3600) / 60)
	const s = total % 60
	return h > 0
		? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
		: `${m}:${String(s).padStart(2, '0')}`
}

/**
 * The shared `listVideos` binding: the video library mapped to kit
 * PickerItems — same mapping the Video tab's library list uses
 * (`video-resource-field.tsx`). Powers the body editor's "Video…" insert.
 */
export async function listVideoPickerItems({
	search,
	excludeIds,
	limit,
}: {
	types?: string[]
	search?: string
	excludeIds?: string[]
	limit?: number
}): Promise<PickerItem[]> {
	const rows = await listVideoResourcesForPicker({
		search,
		excludeIds,
		// The Media tab's "Load more" grows the requested limit page by page —
		// clamp to the server schema's ceiling instead of letting zod throw; a
		// short response just tells the kit the library is exhausted.
		limit: limit != null ? Math.min(limit, 200) : undefined,
	})
	return rows.map((row) => ({
		id: row.id,
		type: 'video',
		title: row.title,
		state: row.state,
		detail: formatDuration(row.duration),
		thumbnailUrl: row.thumbnailUrl,
		updatedAt: row.createdAt ?? undefined,
	}))
}

/**
 * The editor sets `fields.state` before submitting, but derive it from the
 * action anyway so the persisted state can never disagree with the verb.
 * Parity: legacy "Return to Draft" (unpublish) sets 'draft'.
 */
function stateForAction(
	action: ResourceAction,
	current: Post['fields']['state'],
): Post['fields']['state'] {
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

export function createPostBindings({
	resourceId,
	availableTags,
	listMemberships,
	onSlugChange,
}: CreatePostBindingsOptions): ResourceBindings<typeof PostSchema> {
	return {
		update: async (values, action) => {
			if (!values.id || !values.fields) {
				throw new Error('Invalid resource data')
			}
			const postUpdate = {
				id: values.id,
				fields: {
					title: values.fields.title || '',
					body: values.fields.body || '',
					slug: values.fields.slug || '',
					description: values.fields.description || '',
					state: stateForAction(action, values.fields.state || 'draft'),
					visibility: values.fields.visibility || 'public',
					github: values.fields.github || '',
					githubSource: values.fields.githubSource?.trim() || '',
					// PostUpdateSchema's type omits gitpod (hence the cast below), but
					// the manifest renders it and updatePost spreads input.fields over
					// the current fields at runtime — passing it through makes the
					// editor honest instead of silently dropping the field on save.
					gitpod: values.fields.gitpod ?? '',
					thumbnailTime: values.fields.thumbnailTime || 0,
					postType: values.fields.postType || 'article',
					// Persist null (not `{ url: '' }`, and not a stripped key — the
					// server merges fields per-key, so omitting would keep the old
					// image forever) so clearing the cover image actually clears it.
					coverImage: values.fields.coverImage?.url
						? values.fields.coverImage
						: null,
				},
				// updatePost does not persist tags — tag writes happen immediately
				// via the tags binding below (addTagToPost / removeTagFromPost).
				tags: values.tags || [],
			} as PostUpdate
			return await updatePost(postUpdate, action)
		},
		onSave: async (resource, hasNewSlug) => {
			const slug = resource?.fields?.slug
			if (hasNewSlug && slug) {
				onSlugChange?.(slug)
			}
		},
		// Posts live at the site root — no /posts/ prefix (legacy parity).
		getResourcePath: (slug) => `/${slug || ''}`,
		// "Part of" strip — reverse lookup (lists/workshops/products). The app's
		// ResourceParent is a superset of the kit's (adds `slug`), so it plugs in.
		getParents: (id) => getResourceParents(id),
		// The ONE picker query (recent-first + search). In the post editor the
		// only picker surface is list membership, so default to ['list'].
		listRecent: async ({ types, search, excludeIds, limit }) => {
			const items = await listResourcesForPicker({
				types: types?.length ? types : ['list'],
				search,
				excludeIds,
				limit,
			})
			// Kit PickerItem wants `updatedAt?: string | Date` — never null.
			return items.map((item) => ({
				...item,
				updatedAt: item.updatedAt ?? undefined,
			}))
		},
		// Body editor "Video…" insert — the same library the Video tab lists.
		listVideos: listVideoPickerItems,
		// Media-tab video verbs; "Set as primary" targets THIS post.
		videoLibrary: createVideoLibraryBinding({ primaryResourceId: resourceId }),
		lists: {
			// Memberships come from the page's server fetch (`getPostLists`) — the
			// post row itself carries children, not the lists it belongs to.
			getMemberships: () => listMemberships,
			// Immediate join-row writes — same server actions the legacy
			// AddToList combobox called.
			add: async (postId, listId) => {
				await addPostToList({ postId, listId })
			},
			remove: async (postId, listId) => {
				await removePostFromList({ postId, listId })
			},
		},
		media: {
			// Same Cloudinary dir the legacy image tool used: `posts/{postId}`.
			upload: (file) => uploadToCloudinary(file, `posts/${resourceId}`),
			// The app's primitive DB-backed image library (`imageResource` rows) —
			// the same source the legacy ImageResourceBrowser rendered.
			list: listImageMediaAssets,
			// Kit-driven video upload (uploadthing → Inngest pipeline) — pairs
			// with `listVideos` to make the Media tab a full video surface.
			uploadVideo: uploadVideoMedia,
		},
		// bindings.ai (SEO "✦ Generate") is DELIBERATELY unwired. The kit needs a
		// `generate` that RETURNS the generated string, but the legacy path is
		// fire-and-forget: `sendResourceChatMessage` emits an Inngest event
		// (RESOURCE_CHAT_REQUEST_EVENT, workflow 'prompt-0541t') and the result
		// arrives later via a PartyKit socket broadcast ('resource.chat.completed'
		// in the old PostMetadataFormFields useSocket). No callable server path
		// returns a string, and hacking a socket-wait into a promise is out of
		// scope — the button simply doesn't render until a real server action
		// (e.g. direct LLM call with the prompt-0541t prompt) exists.
		tags: {
			getResourceTags: (resource: Post) =>
				resource?.tags?.map(({ tag }) => ({
					id: tag.id,
					label: tag.fields.label,
				})) ?? [],
			availableTags,
			// Immediate entity writes, independent of form save — same server
			// actions the legacy AdvancedTagSelector called.
			add: async (resourceId, tag) => {
				await addTagToPost(resourceId, tag.id)
			},
			remove: async (resourceId, tag) => {
				await removeTagFromPost(resourceId, tag.id)
			},
		},
	}
}
