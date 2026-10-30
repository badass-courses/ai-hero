import { Flow } from '../flow'
import type { Redraws } from '../redraws'
import { autoRebase, SCHEDULE_BEFORE_BLOCKED } from './auto-rebase'
import { FlowBoard } from './board'
import { exploreTickets } from './explore-tickets'
import {
	BEFORE_STOP,
	improveCodebaseArchitecture,
	improveCodebaseArchitectureNoHuman,
} from './improve-codebase-architecture'
import { lintRuleRatchet } from './lint-rule-ratchet'
import { stage } from './stage'

/* Frames Matt grabbed while building a drawing: each lists the steps there by
   then. A step he had selected or was typing into is drawn like the rest:
   the selection is his editor's, not a highlight. */

const improveV1 = {
	spawn: 'Once per day, spawn a runner',
	stop: 'Stop if >5 existing tickets',
}
const improveFinal = stage(improveCodebaseArchitecture, {
	nodes: [
		'spawn',
		'fetch',
		'stop',
		'run',
		'create',
		'review',
		'label',
		'implement',
		'more',
	],
	without: BEFORE_STOP,
})
const improveBeforeStop = ['spawn', 'run', 'create', 'review', 'label']
const improveWithStop = [
	'spawn',
	'fetch',
	'stop',
	'run',
	'create',
	'review',
	'label',
	'hidden',
]

const ratchetSteps = ['spawn', 'fetch', 'stop', 'find', 'fix', 'pr', 'human']
const ratchetScripts = { scripts: 'npm run lint:all\nnpm run lint:strict' }
const ratchetFinal = stage(lintRuleRatchet, {
	nodes: [...ratchetSteps, 'scripts', 'graduate', 'graduation-pr'],
})

const rebaseStart = ['fetch', 'midnight', 'schedule', 'runner']
const rebaseBranches = [
	...rebaseStart,
	'attempt',
	'works',
	'conflicts',
	'force-push',
]
const rebaseEarly = stage(autoRebase, {
	nodes: rebaseStart,
	text: SCHEDULE_BEFORE_BLOCKED,
})

/** Explore Tickets, /improve-codebase-architecture, Lint Rule Ratchet and
    Auto-Rebase. */
export const flowRedrawsPartOne: Redraws = {
	// Frames of Matt's tldraw board itself, its template of role tags beside
	// an empty drawing, keep his image: the lesson sends the learner to that
	// board, so they should see the board they will open.
	'ai-hero-images/0a79b278f76b033da33c7b0f37d79400': () => (
		<Flow diagram={exploreTickets} />
	),

	// /improve-codebase-architecture
	'ai-hero-images/3757e904bb6a6aa51799ed561a673872': () => (
		<Flow
			diagram={stage(improveCodebaseArchitecture, {
				nodes: ['spawn', 'run'],
				text: improveV1,
			})}
		/>
	),
	'ai-hero-images/944cad8f9e630a23dc0b4f80b2cf752d': () => (
		<Flow
			diagram={stage(improveCodebaseArchitecture, {
				nodes: ['spawn', 'run', 'create'],
				text: { ...improveV1, create: 'Creates a new ticket' },
			})}
		/>
	),
	'ai-hero-images/8c4ce67df9e2ba2763f8af66265f00af': () => (
		<Flow
			diagram={stage(improveCodebaseArchitecture, {
				nodes: improveBeforeStop,
				text: { ...improveV1, create: 'Creates a new ticket' },
			})}
		/>
	),
	'ai-hero-images/ef76c0096a1e6e6d50f98f6022704c58': () => (
		<Flow
			diagram={stage(improveCodebaseArchitecture, {
				nodes: [...improveBeforeStop, 'fetch', 'hidden'],
				text: { ...improveV1, create: 'Creates a new ticket' },
			})}
		/>
	),
	'ai-hero-images/a253c1ff9c4109f34064714923306ead': () => (
		<Flow
			diagram={stage(improveCodebaseArchitecture, {
				nodes: improveWithStop,
				text: { ...improveV1, create: 'Creates a new ticket with a label' },
				without: BEFORE_STOP,
			})}
		/>
	),
	'ai-hero-images/d0668c874a09d56d0a00cba0dcc1b74b': () => (
		<Flow
			diagram={stage(improveCodebaseArchitecture, {
				nodes: improveWithStop,
				text: improveV1,
				without: BEFORE_STOP,
			})}
		/>
	),
	'ai-hero-images/64eaa9da91d1a19cf8e56c9a8dc72a46': () => (
		<Flow diagram={improveFinal} />
	),
	'ai-hero-images/a3519fbbf88405183371de92ce869416': () => (
		<FlowBoard diagrams={[improveFinal, improveCodebaseArchitectureNoHuman]} />
	),
	'ai-hero-images/6c82b3765302d4f10afc78b40086b7af': () => (
		<FlowBoard diagrams={[improveFinal, improveCodebaseArchitectureNoHuman]} />
	),

	// Lint Rule Ratchet
	'ai-hero-images/74776ef43440d8509a6a2d059fd0bc03': () => (
		<Flow
			diagram={stage(lintRuleRatchet, {
				nodes: ['spawn', 'fetch', 'stop', 'after-stop'],
			})}
		/>
	),
	'ai-hero-images/ba47a8d0fb6637054fab239fb27959c4': () => (
		<Flow
			diagram={stage(lintRuleRatchet, {
				nodes: ['spawn', 'fetch', 'stop', 'find', 'after-find'],
			})}
		/>
	),
	'ai-hero-images/90204663ced07b6afe8b529bede14632': () => (
		<Flow
			diagram={stage(lintRuleRatchet, { nodes: ratchetSteps.slice(0, 5) })}
		/>
	),
	'ai-hero-images/216186d37efc5e3741695576392b92e5': () => (
		<Flow
			diagram={stage(lintRuleRatchet, { nodes: ratchetSteps.slice(0, 6) })}
		/>
	),
	'ai-hero-images/342e3171229eada39b79767ab00b9b73': () => (
		<Flow
			diagram={stage(lintRuleRatchet, {
				nodes: ratchetSteps,
				text: { human: 'Reviews the PR' },
			})}
		/>
	),
	'ai-hero-images/59b51ffcb8c8292f54807ace9b2a984d': () => (
		<Flow
			diagram={stage(lintRuleRatchet, { nodes: [...ratchetSteps, 'on-merge'] })}
		/>
	),
	'ai-hero-images/e5c5dc57b5d409b79e9f53bfdb1d2852': () => (
		<Flow
			diagram={stage(lintRuleRatchet, {
				nodes: [...ratchetSteps, 'scripts'],
				text: ratchetScripts,
			})}
		/>
	),
	'ai-hero-images/14b72a64dd34f1ececbdd123cf5fc8c7': () => (
		<Flow
			diagram={stage(lintRuleRatchet, {
				nodes: [...ratchetSteps, 'scripts', 'graduate', 'graduation-pr'],
				text: ratchetScripts,
			})}
		/>
	),
	'ai-hero-images/737a55541ae7f14aa5ea40ced48bdaa5': () => (
		<Flow diagram={ratchetFinal} />
	),

	// Auto-Rebase
	'ai-hero-images/fbed2f2ae6db093369f527b2fda2a1cb': () => (
		<Flow diagram={rebaseEarly} />
	),
	'ai-hero-images/6ee0b3d8e46407aa9e42e424686937dc': () => (
		<Flow diagram={rebaseEarly} />
	),
	'ai-hero-images/00e0319916f40f26aa71ae866deec544': () => (
		<Flow
			diagram={stage(autoRebase, {
				nodes: [...rebaseStart, 'attempt'],
				text: SCHEDULE_BEFORE_BLOCKED,
			})}
		/>
	),
	'ai-hero-images/7374f11febdf9786408fc34a4a92fd78': () => (
		<Flow
			diagram={stage(autoRebase, {
				nodes: rebaseBranches,
				text: SCHEDULE_BEFORE_BLOCKED,
				without: ['conflicts-force-push'],
			})}
		/>
	),
	'ai-hero-images/9e388bc4d7a6038f16cddf4a630cda3a': () => (
		<Flow
			diagram={stage(autoRebase, {
				nodes: [...rebaseBranches, 'label-added'],
				text: SCHEDULE_BEFORE_BLOCKED,
			})}
		/>
	),
	'ai-hero-images/7e919b24b31d1524891e9cafb8f3093b': () => (
		<Flow
			diagram={stage(autoRebase, {
				nodes: [...rebaseBranches, 'label-added', 'unresolved', 'issue'],
				text: SCHEDULE_BEFORE_BLOCKED,
			})}
		/>
	),
	'ai-hero-images/7c0ffdea1cdcb5c65afc4533fc40fbbb': () => (
		<Flow diagram={autoRebase} />
	),
}
