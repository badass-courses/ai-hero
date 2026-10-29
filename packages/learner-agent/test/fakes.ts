import type {
	CourseStructure,
	Learner,
	LearnerAgentPorts,
	LessonContent,
	OwnedCourse,
} from '../src/index.js'

export const BASE = 'https://aihero.test'

export const learner: Learner = {
	userId: 'user-owner',
	tokenKind: 'learner-token',
}
export const refunded: Learner = {
	userId: 'user-refunded',
	tokenKind: 'learner-token',
}
export const otherLearner: Learner = {
	userId: 'user-other',
	tokenKind: 'device-token',
}

const cohort: CourseStructure = {
	course: {
		id: 'cohort-1',
		slug: 'ai-coding',
		title: 'AI Coding Crash Course',
		type: 'cohort',
		url: `${BASE}/cohorts/ai-coding`,
	},
	workshops: [
		{
			id: 'w-open',
			slug: 'week-one',
			title: 'Week One',
			url: `${BASE}/workshops/week-one`,
			opensAt: '2026-01-01T00:00:00.000Z',
			sections: [
				{
					title: 'Start',
					lessons: [
						{
							id: 'lesson-1',
							slug: 'first-lesson',
							title: 'First lesson',
							type: 'lesson',
							url: `${BASE}/workshops/week-one/first-lesson`,
						},
						{
							id: 'lesson-2',
							slug: 'second-lesson',
							title: 'Refactor with skills',
							type: 'lesson',
							url: `${BASE}/workshops/week-one/second-lesson`,
						},
					],
				},
			],
		},
		{
			id: 'w-embargoed',
			slug: 'week-two',
			title: 'Week Two',
			url: `${BASE}/workshops/week-two`,
			opensAt: '2099-01-01T00:00:00.000Z',
			sections: [
				{
					title: null,
					lessons: [
						{
							id: 'lesson-locked',
							slug: 'locked-lesson',
							title: 'Locked lesson',
							type: 'lesson',
							url: `${BASE}/workshops/week-two/locked-lesson`,
						},
					],
				},
			],
		},
	],
}

const otherCourse: CourseStructure = {
	course: {
		id: 'w-other',
		slug: 'other',
		title: 'Other workshop',
		type: 'workshop',
		url: `${BASE}/workshops/other`,
	},
	workshops: [
		{
			id: 'w-other',
			slug: 'other',
			title: 'Other workshop',
			url: `${BASE}/workshops/other`,
			opensAt: null,
			sections: [
				{
					title: null,
					lessons: [
						{
							id: 'lesson-other',
							slug: 'other-lesson',
							title: 'Other lesson',
							type: 'lesson',
							url: `${BASE}/workshops/other/other-lesson`,
						},
					],
				},
			],
		},
	],
}

export const ownedCohort: OwnedCourse = {
	...cohort.course,
	workshops: [
		{
			id: 'w-open',
			slug: 'week-one',
			title: 'Week One',
			url: `${BASE}/workshops/week-one`,
			opensAt: '2026-01-01T00:00:00.000Z',
			isOpen: true,
		},
		{
			id: 'w-embargoed',
			slug: 'week-two',
			title: 'Week Two',
			url: `${BASE}/workshops/week-two`,
			opensAt: '2099-01-01T00:00:00.000Z',
			isOpen: false,
		},
	],
	nextOpensAt: '2099-01-01T00:00:00.000Z',
}

export const lessonOne: LessonContent = {
	lesson: {
		id: 'lesson-1',
		slug: 'first-lesson',
		title: 'First lesson',
		type: 'lesson',
	},
	workshop: { id: 'w-open', slug: 'week-one', title: 'Week One' },
	body: 'Build the thing.',
	transcript: 'Today we build the thing.',
	solution: { title: 'Solution', body: 'Here is the answer.' },
	sessionExtract: {
		sessions: [
			{
				sessionId: 's1',
				entries: [
					{ kind: 'userPrompt', visibleFrom: 10, text: 'Add a test' },
					{ kind: 'assistantText', visibleFrom: 20, text: 'Adding it' },
					{
						kind: 'toolCall',
						visibleFrom: 300,
						tool: 'Bash',
						summary: 'pnpm test',
						resultIsError: true,
					},
					{ kind: 'interrupt', visibleFrom: 400, text: '' },
				],
			},
		],
	},
	links: {
		lesson: `${BASE}/workshops/week-one/first-lesson`,
		solution: `${BASE}/workshops/week-one/first-lesson/solution`,
		workshop: `${BASE}/workshops/week-one`,
	},
}

/** Locator → lesson id, the way the app resolves slug or id. */
const lessonIds: Record<string, string> = {
	'first-lesson': 'lesson-1',
	'lesson-1': 'lesson-1',
	'locked-lesson': 'lesson-locked',
	'other-lesson': 'lesson-other',
}

export type Recorder = {
	readonly reads: Array<{
		userId: string
		capability: string
		resourceId: string
	}>
	readonly rateLimitCalls: Array<{ userId: string | null; capability: string }>
}

export function fakePorts(
	caller: Learner | null,
	options: {
		readonly limited?: boolean
		readonly recorder?: Recorder
		readonly leakMux?: boolean
	} = {},
): LearnerAgentPorts {
	const recorder = options.recorder ?? { reads: [], rateLimitCalls: [] }
	const owns = (who: Learner) => who.userId === learner.userId

	return {
		learner: caller,
		entitlements: {
			ownedCourses: async (who) => (owns(who) ? [ownedCohort] : []),
			workshopAccess: async (who, workshopId) => {
				if (!owns(who) || workshopId === 'w-other')
					return { _tag: 'NotEntitled' }
				return workshopId === 'w-embargoed'
					? { _tag: 'NotYetOpen', opensAt: '2099-01-01T00:00:00.000Z' }
					: { _tag: 'Open' }
			},
			lessonAccess: async (who, locator) => {
				const id = lessonIds[locator.lesson]
				if (!id) return { _tag: 'NotFound' }
				if (id === 'lesson-other' || !owns(who)) {
					return {
						_tag: 'NotEntitled',
						workshopUrl: `${BASE}/workshops/week-one`,
					}
				}
				if (id === 'lesson-locked') {
					return {
						_tag: 'NotYetOpen',
						workshopTitle: 'Week Two',
						opensAt: '2099-01-01T00:00:00.000Z',
					}
				}
				return { _tag: 'Readable' }
			},
		},
		content: {
			course: async (idOrSlug) =>
				['cohort-1', 'ai-coding', 'week-one'].includes(idOrSlug)
					? cohort
					: ['w-other', 'other'].includes(idOrSlug)
						? otherCourse
						: null,
			lesson: async (locator) => {
				if (lessonIds[locator.lesson] !== 'lesson-1') return null
				if (!options.leakMux) return lessonOne
				// An adapter that over-returns: the output schema must drop this.
				return {
					...lessonOne,
					muxPlaybackId: 'playback-secret',
					links: { ...lessonOne.links, muxAssetId: 'asset-secret' },
				} as LessonContent
			},
			officeHours: async (cohortId) =>
				cohortId === 'cohort-1'
					? {
							course: 'AI Coding Crash Course',
							sessions: [
								{
									title: 'Past session',
									startsAt: '2020-01-01T17:00:00.000Z',
									endsAt: '2020-01-01T18:00:00.000Z',
									youtubeWatchUrl: 'https://www.youtube.com/watch?v=past',
								},
								{
									title: 'Office Hours',
									startsAt: '2099-03-05T17:00:00.000Z',
									endsAt: '2099-03-05T18:30:00.000Z',
									youtubeWatchUrl: 'https://www.youtube.com/watch?v=next',
								},
							],
						}
					: null,
		},
		progress: {
			completed: async (who, ids) =>
				owns(who) ? ids.filter((id) => id === 'lesson-1') : [],
		},
		search: {
			search: async () => [
				{
					id: 'lesson-2',
					type: 'lesson',
					title: 'Refactor with skills',
					url: `${BASE}/workshops/week-one/second-lesson`,
					summary: 'Skills',
				},
				{
					id: 'post-1',
					type: 'article',
					title: 'Skills in Claude Code',
					url: `${BASE}/skills-in-claude-code`,
					summary: 'An article',
				},
			],
		},
		audit: { read: (event) => void recorder.reads.push(event) },
		rateLimit: {
			consume: async (call) => {
				recorder.rateLimitCalls.push(call)
				return options.limited
					? { ok: false, retryAfterSeconds: 30 }
					: { ok: true }
			},
		},
		site: {
			baseUrl: BASE,
			connectUrl: `${BASE}/agents/connect`,
			instructionsUrl: `${BASE}/api/learner`,
			mcpUrl: `${BASE}/mcp`,
		},
	}
}
