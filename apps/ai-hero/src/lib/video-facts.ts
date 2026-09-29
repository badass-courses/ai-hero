/**
 * What the videos page needs to know about each watchable resource (a post or
 * lesson with its own video) — whether anyone can watch it, which courses
 * grant it, how long it runs — derived from the resource graph instead of
 * stored by hand.
 *
 * Nothing on a resource says "I am a video" or "I am free". Video is a joined
 * `videoResource`; free is a `tier: 'free'` on the join that places a lesson
 * (or its section) in a workshop — the same rule the ability uses in
 * `src/ability/index.ts`. These values depend on rows other than the one being
 * saved, and on the clock (cohort days open on a schedule), which is why the
 * index is both stamped at save time and reconciled hourly.
 *
 * Pure and dependency-free so the rules are unit-testable; the DB read lives
 * in `video-facts-query.ts`.
 */

export type VideoGraphNode = {
	id: string
	type: string
	title?: string | null
	state?: string | null
	visibility?: string | null
	/** `fields.startsAt` — a cohort workshop stays shut until then. */
	startsAt?: string | null
	/** `fields.videoResourceId` — older posts point at their video this way. */
	videoResourceId?: string | null
	/** `fields.duration` — a post-level stamp that wins over the video's own. */
	duration?: number | null
	/** `videoResource` only. */
	muxPlaybackId?: string | null
	/** Seconds into the video for its thumbnail; a leaf's own value wins. */
	thumbnailTime?: number | null
}

export type VideoGraphEdge = {
	parentId: string
	childId: string
	/** `metadata.tier` on the join row. */
	tier?: string | null
}

export type VideoGraph = {
	nodes: VideoGraphNode[]
	edges: VideoGraphEdge[]
}

export type VideoFacts = {
	has_video: boolean
	/** Watchable without a purchase. */
	free: boolean
	/**
	 * Every course (workshop, cohort, list) that currently opens this video —
	 * what "videos from courses you own" filters on. `null` rather than `[]`:
	 * the index auto-types this field and cannot type an empty array.
	 */
	course_ids: string[] | null
	/** Runtime, when known. */
	duration_seconds: number | null
	/** Lessons only: the course the lesson belongs to, as a buyer knows it. */
	container_title: string | null
	/**
	 * The video itself, so a card can show its still (lessons are indexed
	 * without an image) and preview it on hover.
	 */
	mux_playback_id: string | null
	/** Seconds into that video for the still. */
	thumbnail_time: number | null
}

const CONTAINER_TYPES = new Set(['cohort', 'workshop', 'section', 'list', 'tutorial'])
/** Resources that are a video themselves. Solutions ride on their exercise. */
const LEAF_TYPES = new Set(['post', 'lesson', 'exercise', 'tip', 'talk'])
/** Leaves readable by anyone regardless of placement (see ability rules). */
const ALWAYS_FREE_LEAF_TYPES = new Set(['post', 'tip', 'talk'])
/** Parents whose join-row tier grants free access, mirroring the ability. */
const MODULE_TYPES = new Set(['workshop', 'tutorial', 'list'])

export function computeVideoFacts(
	graph: VideoGraph,
	now: Date = new Date(),
): Map<string, VideoFacts> {
	const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
	const children = new Map<string, VideoGraphEdge[]>()
	const parents = new Map<string, VideoGraphEdge[]>()
	for (const edge of graph.edges) {
		if (!nodes.has(edge.parentId) || !nodes.has(edge.childId)) continue
		push(children, edge.parentId, edge)
		push(parents, edge.childId, edge)
	}
	const isOpen = (node: VideoGraphNode) => isOpenAt(node, now)

	const facts = new Map<string, VideoFacts>()
	for (const node of graph.nodes) {
		if (!LEAF_TYPES.has(node.type)) continue
		const video = findPlayableVideo(node, nodes, children.get(node.id))
		const seconds = video
			? (positive(node.duration) ?? positive(video.duration))
			: undefined
		const courseIds = video ? openCourseIds(node.id, parents, nodes, isOpen) : []

		facts.set(node.id, {
			has_video: Boolean(video),
			free: isFreeLeaf(node, parents, nodes, isOpen),
			course_ids: courseIds.length > 0 ? courseIds : null,
			duration_seconds: seconds === undefined ? null : Math.round(seconds),
			container_title:
				node.type === 'post'
					? null
					: rootContainerTitle(node.id, parents, nodes, isOpen),
			mux_playback_id: video?.muxPlaybackId ?? null,
			// Whole seconds: the index auto-types this field from the first value
			// it sees, and a float after an int would be refused.
			thumbnail_time: video
				? roundOrNull(node.thumbnailTime ?? video.thumbnailTime)
				: null,
		})
	}
	return facts
}

/**
 * Whether a container lets a learner through right now. Workshop state and
 * schedule are what gate a course (`isWorkshopAvailable`): cohort days are
 * published ahead and open on `startsAt`. Lesson state is not — the live AI
 * Coding Crash Course is sixty `draft` lessons.
 */
function isOpenAt(node: VideoGraphNode, now: Date): boolean {
	if (node.type !== 'workshop') return true
	if (node.state !== 'published') return false
	if (!node.startsAt) return true
	const startsAt = Date.parse(node.startsAt)
	// An unparseable date is authoring noise, not an embargo (fails open, like
	// `isWorkshopAvailable`).
	return Number.isNaN(startsAt) || startsAt <= now.getTime()
}

/**
 * The courses that open a leaf, walking up through sections, open workshops
 * and the cohorts or lists around them. A closed workshop stops the walk: its
 * lessons are not watchable through it, even by someone who owns the cohort.
 */
function openCourseIds(
	leafId: string,
	parents: Map<string, VideoGraphEdge[]>,
	nodes: Map<string, VideoGraphNode>,
	isOpen: (node: VideoGraphNode) => boolean,
): string[] {
	const courses = new Set<string>()
	const visited = new Set<string>()
	const queue = [leafId]

	while (queue.length > 0) {
		const id = queue.shift()!
		for (const edge of parents.get(id) ?? []) {
			if (visited.has(edge.parentId)) continue
			visited.add(edge.parentId)
			const parent = nodes.get(edge.parentId)
			if (!parent || !CONTAINER_TYPES.has(parent.type) || !isOpen(parent)) {
				continue
			}
			if (parent.type !== 'section') courses.add(parent.id)
			queue.push(parent.id)
		}
	}

	return Array.from(courses).sort()
}

/**
 * Posts, tips and talks are free wherever they sit. A lesson is free when an
 * open module places it — directly or through a section — with `tier: 'free'`.
 */
function isFreeLeaf(
	node: VideoGraphNode,
	parents: Map<string, VideoGraphEdge[]>,
	nodes: Map<string, VideoGraphNode>,
	isOpen: (node: VideoGraphNode) => boolean,
): boolean {
	if (ALWAYS_FREE_LEAF_TYPES.has(node.type)) return true

	const isFreeModuleEdge = (edge: VideoGraphEdge) => {
		const module = nodes.get(edge.parentId)
		return (
			edge.tier === 'free' &&
			Boolean(module) &&
			MODULE_TYPES.has(module!.type) &&
			isOpen(module!)
		)
	}

	return (parents.get(node.id) ?? []).some((edge) => {
		if (isFreeModuleEdge(edge)) return true
		// A section is free when its own placement in a module is free-tier.
		const parent = nodes.get(edge.parentId)
		return (
			parent?.type === 'section' &&
			(parents.get(parent.id) ?? []).some(isFreeModuleEdge)
		)
	})
}

/**
 * The course a lesson belongs to, named the way a buyer knows it: the cohort
 * when the lesson sits in a cohort's day-workshop, otherwise the workshop.
 */
function rootContainerTitle(
	leafId: string,
	parents: Map<string, VideoGraphEdge[]>,
	nodes: Map<string, VideoGraphNode>,
	isOpen: (node: VideoGraphNode) => boolean,
): string | null {
	let best: VideoGraphNode | null = null
	let bestRank = -1
	const visited = new Set<string>()
	const queue = [leafId]

	while (queue.length > 0) {
		const id = queue.shift()!
		for (const edge of parents.get(id) ?? []) {
			if (visited.has(edge.parentId)) continue
			visited.add(edge.parentId)
			const parent = nodes.get(edge.parentId)
			if (!parent || !CONTAINER_TYPES.has(parent.type) || !isOpen(parent)) {
				continue
			}
			queue.push(parent.id)
			if (parent.type === 'section') continue
			const rank = containerRank(parent)
			if (rank > bestRank) {
				best = parent
				bestRank = rank
			}
		}
	}

	return best?.title?.trim() || null
}

/** Prefer published, public, outermost containers. */
function containerRank(node: VideoGraphNode): number {
	const outer = node.type === 'cohort' ? 2 : 1
	const published = node.state === 'published' ? 4 : 0
	const isPublic = node.visibility === 'public' ? 8 : 0
	return outer + published + isPublic
}

function findPlayableVideo(
	node: VideoGraphNode,
	nodes: Map<string, VideoGraphNode>,
	childEdges: VideoGraphEdge[] | undefined,
): VideoGraphNode | null {
	const candidates = [
		node.videoResourceId,
		...(childEdges ?? []).map((edge) => edge.childId),
	]
	for (const id of candidates) {
		if (!id) continue
		const video = nodes.get(id)
		if (
			video?.type === 'videoResource' &&
			video.state === 'ready' &&
			video.muxPlaybackId
		) {
			return video
		}
	}
	return null
}

/** The still Mux renders for a video, sized for a 16:9 card. */
export function muxThumbnailUrl(playbackId: string, time?: number | null) {
	return `https://image.mux.com/${playbackId}/thumbnail.jpg?width=720&height=405&fit_mode=smartcrop&time=${time ?? 0}`
}

function positive(value: number | null | undefined): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value > 0
		? value
		: undefined
}

function roundOrNull(value: number | null | undefined): number | null {
	return typeof value === 'number' && Number.isFinite(value)
		? Math.round(value)
		: null
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
	const list = map.get(key)
	if (list) list.push(value)
	else map.set(key, [value])
}
