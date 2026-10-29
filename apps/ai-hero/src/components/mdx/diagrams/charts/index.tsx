import type { Redraws } from '../redraws'
import { FidelityAxis } from './fidelity'
import { Rings } from './rings'
import { HUE } from './ink'
import { Timeline, type TimelineMarker, type TimelineStep } from './timeline'
import { TrustCurve } from './trust-curve'

const FILE_EDIT: TimelineStep = { label: 'File Edit', hue: HUE.blue }
const COMMIT: TimelineStep = { label: 'Commit', hue: HUE.yellow }
const PUSH: TimelineStep = { label: 'Push', hue: HUE.purple }
const CI: TimelineStep = { label: 'CI', hue: HUE.orange }

/** The pre-commit drawing as it grows: edits up to a commit, then CI after
    it, then a push between the two. */
const EDITS_TO_COMMIT = [FILE_EDIT, FILE_EDIT, FILE_EDIT, FILE_EDIT, COMMIT]
const COMMIT_TO_CI = [FILE_EDIT, FILE_EDIT, COMMIT, CI]
const COMMIT_PUSH_CI = [FILE_EDIT, FILE_EDIT, COMMIT, PUSH, CI]

const FACTORY: readonly TimelineStep[] = [
	{ label: 'Explore', hue: HUE.blue },
	{ label: 'Approve', hue: HUE.orange },
	{ label: 'Implement', hue: HUE.yellow },
	{ label: 'Review', hue: HUE.purple },
	{ label: 'Merge', hue: HUE.green },
]

/** Who runs each factory step, frame by frame, as Matt flips them to AFK. */
const H = 'HITL' as const
const A = 'AFK' as const
const RUNS = {
	allHuman: [H, H, H, H, H],
	implement: [H, H, A, H, H],
	implementReview: [H, H, A, A, H],
	allButApprove: [A, H, A, A, H],
	allButMerge: [A, A, A, A, H],
	mergeEither: [A, A, A, A, 'AFK / HITL'],
} as const satisfies Record<string, readonly TimelineMarker[]>

/** The factory's chain of skips: exploring feeds implementing, which feeds
    review, which feeds the merge. */
const CHAIN = [
	[0, 2],
	[2, 3],
	[3, 4],
] as const

const trust = () => <TrustCurve />
const fidelity = () => <FidelityAxis />
const factory = () => <Timeline steps={FACTORY} />

/** Matt's charts and step timelines. */
export const chartRedraws: Redraws = {
	'ai-hero-images/6ef18ef53d5fb52726c299ae64d9e05f': trust,
	'ai-hero-images/c6e8dbe887c8a4e52c29ec404e995b4c': trust,
	'ai-hero-images/d509369be396f54405a46370237e8814': trust,

	'ai-hero-images/4d490cc4be9f64b5134b4f18d7c1438f': () => <Rings />,
	'ai-hero-images/ffc600c9ccdf5c1ef58eb12f738793fc': () => <Rings />,
	'ai-hero-images/bd505961ae446544b36ba08a7860604b': () => <Rings lit={[3, 4]} />,
	'ai-hero-images/13da005c75234ebb9d391f23051c869b': () => <Rings lit="all" />,

	'ai-hero-images/izajcqkiqb9ks2dit0xk': fidelity,
	'ai-hero-images/zp39jtve9hl6emwqrh8y': fidelity,

	'ai-hero-images/2552851e47da5245b97dbf560addf4b1': () => <Timeline steps={EDITS_TO_COMMIT} />,
	'ai-hero-images/11903a76ff1b71a812c4b84f8d04fb5f': () => <Timeline steps={EDITS_TO_COMMIT} />,
	'ai-hero-images/6ae789c1026a5dc063ff3bd4227eba46': () => <Timeline steps={COMMIT_TO_CI} />,
	'ai-hero-images/d5b9275788fa8dfa0c366f9037627610': () => <Timeline steps={COMMIT_TO_CI} />,
	'ai-hero-images/36bf0387d2d263eb88bbf28bc11089eb': () => <Timeline steps={COMMIT_TO_CI} />,
	'ai-hero-images/8a376dd8aae327a76b4d99e07b435e52': () => <Timeline steps={COMMIT_PUSH_CI} />,

	'ai-hero-images/2f64a4b28df5c041374622fd4e636ed7': factory,
	'ai-hero-images/e183eb9625af0a9da61d446e384e684a': factory,
	'ai-hero-images/ae4c8429d4f3e7a999ef5debed46d1bc': factory,
	'ai-hero-images/492ca1da6f4a6896e1e59ad346d881d7': factory,
	'ai-hero-images/a57064bfc0acaafa5b43d3bd62f5806e': () => (
		<Timeline steps={FACTORY} markers={RUNS.allHuman} />
	),
	'ai-hero-images/eb83f459c93dd8350f40c9400dd49d2c': () => (
		<Timeline steps={FACTORY} markers={RUNS.implement} />
	),
	'ai-hero-images/496f1aba427a2fdf9cb77820aaf10932': () => (
		<Timeline steps={FACTORY} markers={RUNS.implementReview} />
	),
	'ai-hero-images/af35c4f5450744e2feda8b959f75405c': () => (
		<Timeline steps={FACTORY} markers={RUNS.allButApprove} />
	),
	'ai-hero-images/b8adea9bc8670850e5183cc3cb02b991': () => (
		<Timeline steps={FACTORY} markers={RUNS.allButMerge} />
	),
	'ai-hero-images/1ec63e4a8dca1f9434e6a1e1319111a7': () => (
		<Timeline steps={FACTORY} markers={RUNS.mergeEither} />
	),
	'ai-hero-images/db3302f5414b4ecacb8849d06c865e44': () => (
		<Timeline steps={FACTORY} markers={RUNS.mergeEither} />
	),
	'ai-hero-images/1e2c7bca765eafd2af917d88b29e4603': () => (
		<Timeline steps={FACTORY} markers={RUNS.mergeEither} agents />
	),
	'ai-hero-images/c0cd6033a2b7a07eb8d9f9d8e1557257': () => (
		<Timeline steps={FACTORY} arcs={CHAIN} />
	),
}
