import type { GraphDiagram, GraphEdge } from './graph'
import { Source, Step } from './parts'

const SOURCES = [
	{
		id: 'issues',
		title: 'Public Issues',
		text: 'A forum where users can submit feedback to improve the app.',
		enter: 'top',
		at: 0.1,
	},
	{
		id: 'bugs',
		title: 'Bug Reports',
		text: 'Bug reports from Bugsnag or Sentry, or slow queries.',
		enter: 'left',
		at: 0.5,
	},
	{
		id: 'cron',
		title: 'Cron Jobs',
		text: 'Timers that run every X hours/days to fix up code automatically',
		enter: 'bottom',
		at: 0.1,
	},
] as const

/**
 * The software factory's front door, from "Explore Before You Commit": three
 * kinds of input all sweeping into Explore, the first step of what follows.
 */
export const exploreInputs: GraphDiagram = {
	className: 'max-w-[50rem]',
	nodes: [
		...SOURCES.map(({ id, title, text }, i) => ({
			id,
			name: title,
			content: <Source icon={id} title={title} text={text} />,
			wide: { col: 1, row: i + 1, span: 6 },
			narrow: { col: 1, row: i + 1, span: 6 },
		})),
		{
			id: 'explore',
			name: 'Explore',
			content: <Step title="Explore" />,
			wide: { col: 9, row: 2, span: 4, align: 'center' as const },
			narrow: { col: 8, row: 2, span: 5, align: 'center' as const },
		},
	],
	edges: SOURCES.map(
		({ id, enter, at }): GraphEdge => ({
			from: { id, side: 'right', part: 'title' },
			to: { id: 'explore', side: enter, part: 'dot', at },
			shape: 'curve',
		}),
	),
}
