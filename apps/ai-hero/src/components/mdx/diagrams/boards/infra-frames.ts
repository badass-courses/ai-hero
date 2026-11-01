import type { InfraFrame } from './infra'

const GITHUB_ISSUES = {
	name: 'GitHub',
	note: 'We use issues for tracking work.',
}
const GITHUB_PRS = { name: 'GitHub', note: 'Pull requests and branches.' }
const ACTIONS_RUNNER = {
	name: 'GitHub Actions',
	note: 'Gives us free workflows to let our agents work.',
}
const ACTIONS_ORCHESTRATOR = {
	name: 'GitHub Actions',
	note: 'Handles triggering actions based on labels.',
}
const ACTIONS_OBSERVABILITY = {
	name: 'GitHub Actions - ish',
	note: "While we can view individual runs, we can't see global metrics.",
}

/** The GitHub-only stack, one part more per frame. */
const GITHUB_STACK = {
	tracker: GITHUB_ISSUES,
	git: GITHUB_PRS,
	runner: ACTIONS_RUNNER,
	orchestrator: ACTIONS_ORCHESTRATOR,
	observability: ACTIONS_OBSERVABILITY,
} as const

const firstPicks = (count: number): InfraFrame['picks'] =>
	Object.fromEntries(Object.entries(GITHUB_STACK).slice(0, count))

/** Matt's own picks in "Choosing your infrastructure", as he fills them in. */
const MATTS = {
	tracker: { name: 'Linear' },
	git: { name: 'GitHub' },
	runner: { name: 'Daytona' },
	orchestrator: { name: 'Custom Server + Inngest' },
	observability: { name: 'Langfuse Cloud' },
} as const

const PRIORITISED = { parts: 5, arrows: true, priorities: true } as const

/**
 * Every grab of the infrastructure board, keyed by the image's hash. In
 * "What infrastructure do I need" Matt adds one part and its GitHub pick at a
 * time, listing the other options under the newest; then he clears the picks,
 * marks priorities, and fills in his own stack.
 */
export const INFRA_FRAMES: Record<string, InfraFrame> = {
	d8d7b9a8f6f135cc5ad796b0ecf0551b: { parts: 5 },
	'796836e7a898dbd21338d4bec4482d88': { parts: 1 },
	'7904c05398544f99f77391043ad5307b': {
		parts: 1,
		arrows: true,
		picks: firstPicks(1),
		alternatives: {
			part: 'tracker',
			lines: [['Jira', 'Linear', 'Trello'], ['Asana']],
		},
	},
	'2fe6e422fec88548239a69049604a597': {
		parts: 2,
		arrows: true,
		picks: firstPicks(2),
	},
	'5aa73fbdef26b1907144d8a6ae2d2d3e': {
		parts: 2,
		arrows: true,
		picks: firstPicks(2),
		alternatives: {
			part: 'git',
			lines: [
				['GitLab', 'BitBucket'],
				['Forgejo', 'Gitea'],
			],
		},
	},
	'6884326ec7aa3b66f9e1b789ac3c77e9': {
		parts: 3,
		arrows: true,
		picks: firstPicks(3),
	},
	'5f0134207dc971536767a132bba79203': {
		parts: 3,
		arrows: true,
		picks: firstPicks(3),
		alternatives: {
			part: 'runner',
			lines: [['Your Own VPS'], ['E2B', 'Daytona']],
		},
	},
	a3fff508938d15b96cbbeb72da39ba12: {
		parts: 4,
		arrows: true,
		picks: firstPicks(4),
	},
	'7985922a70f151a63d97b3fa8b70936d': {
		parts: 4,
		arrows: true,
		picks: firstPicks(4),
		alternatives: {
			part: 'orchestrator',
			lines: [
				['Your Own Orchestrator'],
				['Symphony'],
				['Hosted Agent Platform'],
			],
		},
	},
	'2cbe337e8adb79fc9b91f613ce5b8a6d': {
		parts: 5,
		arrows: true,
		picks: firstPicks(5),
	},
	bf12278568f889ce234449d267b46c80: {
		parts: 5,
		arrows: true,
		picks: firstPicks(5),
		alternatives: {
			part: 'observability',
			lines: [['Langfuse', 'Langsmith'], ['Model Provider']],
		},
	},
	fc5bebf846fccdb7edb970afbe6a4de6: { parts: 5, arrows: true },
	'3089654f96f62a8ef328be2a65a36447': PRIORITISED,
	'6bf2a04ff62856d23ddf33cdeb8ee016': {
		...PRIORITISED,
		picks: {
			...MATTS,
			orchestrator: { name: 'Custom Server' },
			observability: { name: 'Langfuse' },
		},
	},
	// "Choosing your infrastructure" opens on the prioritised board again.
	'0e6380dc2a17a769afc653ae9dc49c16': PRIORITISED,
	'970009b3b78f6f03ec53c895674ec6c5': {
		...PRIORITISED,
		picks: {
			tracker: MATTS.tracker,
			git: MATTS.git,
			orchestrator: MATTS.orchestrator,
		},
	},
	'9ce46b55641faa470c395ee102d55b26': {
		...PRIORITISED,
		picks: {
			tracker: MATTS.tracker,
			git: MATTS.git,
			runner: MATTS.runner,
			orchestrator: MATTS.orchestrator,
		},
	},
	'7817a7c7e1f11dbf67c36d3c25f90cad': { ...PRIORITISED, picks: MATTS },
	'8dd0467e0528b45a76343df2ca84ccf5': { ...PRIORITISED, picks: MATTS },
}
