import { Flow } from '../flow'
import type { Redraws } from '../redraws'
import {
	implementSpec,
	implementSpecExplore,
	implementSpecFrontier,
	implementSpecHeading,
	implementSpecRunners,
	implementSpecSubagents,
	implementSpecTickets,
	implementSpecTriage,
} from './implement-spec'
import { implementSpecV2 } from './implement-spec-v2'
import {
	prototyping,
	prototypingCreate,
	prototypingDraft,
	prototypingFollowUp,
	prototypingNeeded,
	prototypingReacts,
	prototypingStart,
	prototypingUpdate,
} from './prototyping'
import {
	slowQueryAlert,
	slowQueryApi,
	slowQueryExisting,
	slowQueryFix,
	slowQueryFixTicket,
	slowQueryGroups,
	slowQueryHeading,
	slowQueryMonitor,
	slowQuerySevere,
	slowQueryTrigger,
	slowQueryUpdate,
} from './slow-query-monitor'
import { WayfinderDecisionTree } from './wayfinder-decision-tree'

/**
 * Slow Query Monitor, Prototyping, Implement Spec and Implement Spec v2, and
 * the wayfinder decision tree. Most images are frames of a video in which
 * Matt builds a drawing and scrolls through it. Where a frame shows only part
 * of the drawing, `focus` is the part in view and the rest steps back.
 */
export const flowRedrawsPartTwo: Redraws = {
	// Slow Query Monitor
	'ai-hero-images/488161e805bfb153b1b4b37102a9e07c': () => (
		<Flow diagram={slowQueryHeading} />
	),
	'ai-hero-images/63efb689452ae00afb8ba9f600f5ddda': () => (
		<Flow diagram={slowQueryAlert} />
	),
	'ai-hero-images/441a41bc957cd6771c4671cd03b865a5': () => (
		<Flow diagram={slowQueryFix} />
	),
	'ai-hero-images/26df9a76be8c6090cea3774174fd0351': () => (
		<Flow diagram={slowQueryFixTicket} />
	),
	'ai-hero-images/4f81808c4e207052d8cd4861895adb80': () => (
		<Flow
			diagram={slowQueryGroups}
			focus={[
				'receives',
				'puts',
				'pull-alerts',
				'group',
				'ticket-each',
				'fix',
				'pr',
			]}
		/>
	),
	'ai-hero-images/c70433d2a0431a3438063610fd2a69cb': () => (
		<Flow
			diagram={slowQueryExisting}
			focus={[
				'receives',
				'puts',
				'pull-alerts',
				'pull-tickets',
				'group',
				'ticket-each',
				'fix',
				'pr',
			]}
		/>
	),
	'ai-hero-images/a98200067acc94e5f763bc5f05717c72': () => (
		<Flow
			diagram={slowQueryTrigger}
			focus={[
				'receives',
				'puts',
				'pull-alerts',
				'pull-tickets',
				'group',
				'ticket-each',
				'trigger',
				'fix',
			]}
		/>
	),
	'ai-hero-images/9fef0cdc4e5157e586a084a012882459': () => (
		<Flow
			diagram={slowQueryUpdate}
			focus={[
				'pull-alerts',
				'pull-tickets',
				'group',
				'ticket-each',
				'trigger',
				'fix',
				'pr',
				'fix-ticket',
			]}
		/>
	),
	'ai-hero-images/738bc5e9cc1567cee75945cfc0806420': () => (
		<Flow
			diagram={slowQueryApi}
			focus={['pull-alerts', 'pull-tickets', 'group', 'ticket-each', 'trigger']}
		/>
	),
	'ai-hero-images/1f6bb72f6b601ec6fb07611a8e4cf3a0': () => (
		<Flow
			diagram={slowQuerySevere}
			focus={[
				'pull-alerts',
				'pull-tickets',
				'group',
				'ticket-each',
				'trigger',
				'fix',
			]}
		/>
	),
	'ai-hero-images/e57920d6e885babe446c193a2d8e735d': () => (
		<Flow
			diagram={slowQueryMonitor}
			focus={[
				'pull-alerts',
				'pull-tickets',
				'group',
				'ticket-each',
				'trigger',
				'fix',
			]}
		/>
	),
	'ai-hero-images/b47a44a6ffb4332a3571d9caff2c74b1': () => (
		<Flow diagram={slowQueryMonitor} />
	),

	// Prototyping
	'ai-hero-images/3ce73961a5a1701960ae0d48b69b9080': () => (
		<Flow diagram={prototypingStart} />
	),
	'ai-hero-images/7770e7380ce3f2025acb716df2567a35': () => (
		<Flow diagram={prototypingNeeded} />
	),
	'ai-hero-images/d02a9b925e9b5b7a33c69d1b7b32b04f': () => (
		<Flow
			diagram={prototypingCreate}
			focus={[
				'simple',
				'complex',
				'implement',
				'simple-comment',
				'needed',
				'kick-off',
				'comment',
				'create',
			]}
		/>
	),
	'ai-hero-images/89c1c208eed669cec4e2414cbf53009e': () => (
		<Flow
			diagram={prototypingDraft}
			focus={[
				'simple-comment',
				'needed',
				'kick-off',
				'create',
				'comment',
				'draft',
			]}
		/>
	),
	'ai-hero-images/d8c765b8988a842801a3f03f9ee1e0a3': () => (
		<Flow
			diagram={prototypingReacts}
			focus={['kick-off', 'create', 'comment', 'draft', 'reacts']}
		/>
	),
	'ai-hero-images/a2eadacea1cfe8040459f934b1d5a8ea': () => (
		<Flow
			diagram={prototypingFollowUp}
			focus={[
				'needed',
				'kick-off',
				'follow-up',
				'create',
				'comment',
				'draft',
				'reacts',
			]}
		/>
	),
	'ai-hero-images/dfffc3359e16d6f2dffcb1f295b1d2e2': () => (
		<Flow
			diagram={prototypingUpdate}
			focus={[
				'needed',
				'kick-off',
				'follow-up',
				'create',
				'comment',
				'draft',
				'reacts',
			]}
		/>
	),
	'ai-hero-images/e047e5005cdde4e88a25cfa0ea82f5bf': () => (
		<Flow
			diagram={prototyping}
			focus={[
				'explore',
				'simple',
				'complex',
				'implement',
				'simple-comment',
				'needed',
				'tagged',
				'kick-off',
				'follow-up',
				'create',
				'comment',
				'draft',
			]}
		/>
	),
	'ai-hero-images/edd9199bdebb39a8033f061049784938': () => (
		<Flow diagram={prototyping} />
	),

	// Implement Spec, then Implement Spec v2
	'ai-hero-images/37400a04ca7cd7bf16464d4d7f6bee99': () => (
		<Flow diagram={implementSpecHeading} />
	),
	'ai-hero-images/54b805df2b34d3c611241d73076f231a': () => (
		<Flow diagram={implementSpecTriage} />
	),
	'ai-hero-images/13d5a0e77a117b285145314037697391': () => (
		<Flow diagram={implementSpecTickets} />
	),
	'ai-hero-images/05f9784e9e53abab663e6d54b21c85db': () => (
		<Flow diagram={implementSpecExplore} />
	),
	'ai-hero-images/68b6bc0439b9071e5ded4a3b4bcf8e3f': () => (
		<Flow
			diagram={implementSpecFrontier}
			focus={[
				'adds-tickets',
				'explore',
				'save-markdown',
				'exploration-comment',
				'frontier',
			]}
		/>
	),
	'ai-hero-images/fbd383b547b9c75d1a59a8ea9e7d8173': () => (
		<Flow
			diagram={implementSpecRunners}
			focus={['save-markdown', 'exploration-comment', 'frontier', 'build']}
		/>
	),
	'ai-hero-images/3a06a866f689a965d119a86033a41199': () => (
		<Flow
			diagram={implementSpecSubagents}
			focus={['save-markdown', 'exploration-comment', 'frontier', 'build']}
		/>
	),
	'ai-hero-images/4fb0fd33acf991fec7ac9c626da8f4a9': () => (
		<Flow
			diagram={implementSpec}
			focus={[
				'build',
				'not-complete',
				'merge',
				'close-tickets',
				'save-merged',
				'complete',
				'review',
			]}
		/>
	),
	'ai-hero-images/da341d0b0521bf16bccceaec22d8436f': () => (
		<Flow
			diagram={implementSpecV2}
			focus={[
				'labelled',
				'no-tickets',
				'has-tickets',
				'to-tickets',
				'adds-tickets',
				'explore',
			]}
		/>
	),
	'ai-hero-images/d02ed9410873d801c136b87ca6de0fc8': () => (
		<Flow
			diagram={implementSpecV2}
			focus={[
				'for-each',
				'build',
				'save-code',
				'all-complete',
				'not-complete',
				'merge',
				'close-tickets',
				'save-merged',
				'complete',
			]}
		/>
	),
	// Both drawings side by side, as Matt left the board.
	'ai-hero-images/0336be7535e0994d7d317e8c6126f1d3': () => (
		<div className="not-prose @container my-8">
			<div className="grid gap-x-10 @2xl:grid-cols-2">
				<Flow diagram={implementSpec} />
				<Flow diagram={implementSpecV2} />
			</div>
		</div>
	),
	'ai-hero-images/ed01d9d48a02cd95c0a07cd677ff5b54': () => (
		<Flow diagram={implementSpecV2} />
	),

	// Grill vs Wayfinder vs Ship First: two grabs of the same drawing.
	'ai-hero-images/kvm8j9wnirbjpvn3a9mg': () => <WayfinderDecisionTree />,
	'ai-hero-images/u41xqr7sqbdhqnbjgsrl': () => <WayfinderDecisionTree />,
}
