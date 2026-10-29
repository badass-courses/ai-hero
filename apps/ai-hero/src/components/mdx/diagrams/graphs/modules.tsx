import type { GraphDiagram, GraphEdge } from './graph'
import { DepthRule, ModuleBox, Note } from './parts'

/**
 * Matt's module drawings from "A Language for Good Codebases". The terms and
 * definitions are his, word for word, including the dash in Implementation's.
 */

/** What JSON.parse hides behind its one-line interface. */
export const JSON_PARSE = [
	'Tokenizing',
	'String Escapes',
	'Surrogate Pairs',
	'Number Formats',
	'Error Positions',
	'Reviver Callbacks',
] as const

/** A red pointer from a note's title to the thing it names. */
function pointer(
	from: string,
	fromSide: GraphEdge['from']['side'],
	to: GraphEdge['to'],
	fromAt?: number,
): GraphEdge {
	return {
		from: { id: from, side: fromSide, part: 'title', at: fromAt },
		to,
		ink: 'note',
		level: fromSide !== 'top',
	}
}

/**
 * A module, its interface and its implementation, each named and defined.
 * The frames fill the box in: empty, then JSON.parse on the interface, then
 * the implementation details listed inside.
 */
export function moduleAnatomy({
	head,
	items,
}: { head?: string; items?: readonly string[] } = {}): GraphDiagram {
	return {
		className: 'max-w-[54rem]',
		nodes: [
			{
				id: 'module-term',
				content: (
					<Note
						size="lg"
						title="Module"
						text="Anything with an interface and an implementation."
						className="max-w-[17rem]"
					/>
				),
				wide: { col: 1, row: 1, span: 6 },
			},
			{
				id: 'module',
				name: head ?? 'Module',
				content: <ModuleBox head={head} items={items} className="min-h-[17rem]" />,
				wide: { col: 1, row: 2, span: 5, rows: 3 },
				narrow: { col: 1, row: 2, span: 5, rows: 3 },
			},
			{
				id: 'interface',
				content: (
					<Note
						size="md"
						title="Interface"
						text="Everything a caller must know to use the module correctly."
						className="max-w-[17rem]"
					/>
				),
				wide: { col: 7, row: 2, span: 6, justify: 'start' },
			},
			{
				id: 'implementation',
				content: (
					<Note
						size="md"
						title="Implementation"
						text="What's inside a module — its body of code."
						className="max-w-[17rem]"
					/>
				),
				wide: { col: 7, row: 3, span: 6, justify: 'start', align: 'center' },
			},
		],
		edges: [
			pointer('interface', 'left', { id: 'module', side: 'right', part: 'head' }, 0.5),
			{
				...pointer('implementation', 'left', {
					id: 'module',
					side: 'right',
					inset: 52,
				}),
				narrow: { to: { inset: 14 } },
			},
		],
	}
}

/**
 * Depth: a deep module beside a shallow one, with the dashed rule that
 * measures it. The deep module is empty in one frame and lists JSON.parse's
 * insides in the other.
 */
export function moduleDepth({
	head,
	items,
}: { head?: string; items?: readonly string[] } = {}): GraphDiagram {
	return {
		className: 'max-w-[50rem]',
		nodes: [
			{
				id: 'depth',
				content: (
					<Note
						title="Depth"
						text="The amount of behaviour a caller can exercise per unit of interface they have to learn."
						className="max-w-[11rem] @2xl:items-end @2xl:text-right"
					/>
				),
				wide: { col: 1, row: 2, span: 3, justify: 'end', align: 'center' },
				narrow: { col: 1, row: 1, span: 12 },
			},
			{
				id: 'depth-rule',
				content: <DepthRule />,
				wide: { col: 4, row: 1, span: 1, rows: 3, justify: 'end', align: 'stretch' },
				narrow: { col: 1, row: 2, span: 1, rows: 3, align: 'stretch' },
			},
			{
				id: 'deep',
				name: 'Deep Module',
				content: <ModuleBox head={head} items={items} className="min-h-[15rem]" />,
				wide: { col: 5, row: 1, span: 3, rows: 3 },
				narrow: { col: 2, row: 2, span: 5, rows: 3 },
			},
			{
				id: 'shallow',
				name: 'Shallow Module',
				content: <ModuleBox className="h-14" />,
				wide: { col: 8, row: 1, span: 4 },
				narrow: { col: 7, row: 2, span: 6 },
			},
			{
				id: 'shallow-label',
				content: <Note title="Shallow Module" />,
				wide: { col: 8, row: 2, span: 4, justify: 'center' },
				narrow: { col: 7, row: 3, span: 6, justify: 'center' },
			},
			{
				id: 'deep-label',
				content: <Note title="Deep Module" />,
				wide: { col: 8, row: 3, span: 4, align: 'end' },
				narrow: { col: 7, row: 4, span: 6, align: 'end' },
			},
		],
		edges: [
			pointer('shallow-label', 'top', { id: 'shallow', side: 'bottom', at: 0.45 }, 0.45),
			pointer('deep-label', 'top', { id: 'deep', side: 'right', at: 0.8 }, 0.35),
		],
	}
}

/** What depth buys: locality for the module's maintainers, leverage for its
    callers, both pointing at one deep module. */
export const depthPayoff: GraphDiagram = {
	className: 'max-w-[48rem]',
	nodes: [
		{
			id: 'locality',
			content: (
				<Note
					size="md"
					align="end"
					title="Locality"
					text="What maintainers get from depth. Changes and bugs concentrate at one place."
					className="max-w-[16rem]"
				/>
			),
			wide: { col: 1, row: 1, span: 6, justify: 'end', align: 'center' },
			narrow: { col: 1, row: 1, span: 7, justify: 'end', align: 'center' },
		},
		{
			id: 'leverage',
			content: (
				<Note
					size="md"
					align="end"
					title="Leverage"
					text="What callers get from depth. More capability per unit of interface they have to learn."
					className="max-w-[16rem]"
				/>
			),
			wide: { col: 1, row: 2, span: 6, justify: 'end', align: 'center' },
			narrow: { col: 1, row: 2, span: 7, justify: 'end', align: 'center' },
		},
		{
			id: 'module',
			content: <ModuleBox className="min-h-[24rem]" />,
			wide: { col: 8, row: 1, span: 4, rows: 2 },
			narrow: { col: 9, row: 1, span: 4, rows: 2 },
		},
	],
	edges: [
		pointer('locality', 'right', { id: 'module', side: 'left', at: 0.24 }),
		pointer('leverage', 'right', { id: 'module', side: 'left', at: 0.7 }),
	],
}
