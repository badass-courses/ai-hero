import * as React from 'react'
import { TYPE } from '@/components/landing/type'

import { cn } from '@coursebuilder/ui/utils/cn'

/**
 * The two players. Every description is Matt's, broken by hand once per
 * layout because SVG text does not wrap. `advance` is the title's width in
 * the drawing's units: SVG has no layout, so centring an icon and a title as
 * one pair means knowing how wide the title is. It is also set as the title's
 * `textLength`, which keeps the number true under a fallback font.
 */
const PLAYERS = {
	agent: {
		title: 'The Agent',
		Icon: AgentIcon,
		advance: 72,
		wide: ['The model and harness building', 'the code. The tactician.'],
		narrow: ['The model and harness building', 'the code. The tactician.'],
	},
	team: {
		title: 'The Team',
		Icon: TeamIcon,
		advance: 68,
		wide: [
			'The actual humans working on the codebase & factory.',
			'The strategic thinkers.',
		],
		narrow: [
			'The actual humans working on the',
			'codebase & factory. The strategic thinkers.',
		],
	},
} as const

/** The four things the team makes, on the arm that makes the agent go faster
    and on the arm that slows it down. */
const PARTS = {
	brakes: {
		title: 'Brakes',
		accent: true,
		wide: [
			'Automated checks, automated &',
			'human review. Slows the agent',
			'down and increases quality.',
		],
		narrow: [
			'Automated checks,',
			'automated & human',
			'review. Slows the',
			'agent down and',
			'increases quality.',
		],
	},
	knowledge: {
		title: 'Knowledge',
		accent: true,
		wide: [
			'Codebase design, testing,',
			'constraining code, good ol’',
			'software fundamentals.',
		],
		narrow: [
			'Codebase design,',
			'testing,',
			'constraining code,',
			'good ol’ software',
			'fundamentals.',
		],
	},
	accelerators: {
		title: 'Accelerators',
		accent: false,
		wide: [
			'Schedules and triggers that',
			'initiate agents on their own,',
			'without human intervention.',
		],
		narrow: [
			'Schedules and',
			'triggers that initiate',
			'agents on their own,',
			'without human',
			'intervention.',
		],
	},
	infrastructure: {
		title: 'Infrastructure',
		accent: false,
		wide: [
			'Data sources, sandboxes and',
			'scripts that allow agents to',
			'work AFK.',
		],
		narrow: [
			'Data sources,',
			'sandboxes and',
			'scripts that allow',
			'agents to work AFK.',
		],
	},
} as const

type PlayerKey = keyof typeof PLAYERS
type PartKey = keyof typeof PARTS
type NodeKey = PlayerKey | PartKey
type Layout = 'wide' | 'narrow'

/** How far along its line a pulse is as its run goes from 0 to 1. */
type Pace = 'steady' | 'quickening' | 'slowing'

/**
 * The six connections, each with its label and the pace of the pulse that
 * runs it. The two into the agent move the way their labels say: the pulse
 * from the accelerators gathers speed and the one from the brakes loses it.
 */
const EDGES = {
	'team>knowledge': { label: 'Grows', pace: 'steady' },
	'knowledge>brakes': { label: 'Creates', pace: 'steady' },
	'brakes>agent': { label: 'Slows Down', pace: 'slowing' },
	'team>infrastructure': { label: 'Builds', pace: 'steady' },
	'infrastructure>accelerators': { label: 'Creates', pace: 'steady' },
	'accelerators>agent': { label: 'Speeds Up', pace: 'quickening' },
} as const satisfies Partial<
	Record<`${NodeKey}>${NodeKey}`, { label: string; pace: Pace }>
>

type EdgeKey = keyof typeof EDGES

const EDGE_KEYS = Object.keys(EDGES) as EdgeKey[]

/**
 * The two arms, each in the order a pulse relays along it: it leaves the team,
 * lands, and the next one sets off a beat later. One arm runs in each half of
 * the loop, so only one pulse is ever moving.
 */
const ARMS = [
	['team>knowledge', 'knowledge>brakes', 'brakes>agent'],
	['team>infrastructure', 'infrastructure>accelerators', 'accelerators>agent'],
] as const satisfies readonly (readonly EdgeKey[])[]

/** The loop in seconds, a pulse's average speed in SVG user units a second,
    and the beat between one pulse landing and the next leaving. */
const FLOW_LOOP = 12
const FLOW_SPEED = 140
const FLOW_DWELL = 0.35

/** The pulse's length, which `globals.css` repeats in its dash pattern. */
const PULSE = 14

const FLOW_VARS = { '--flow-loop': `${FLOW_LOOP}s` } as React.CSSProperties

/** Both shaped paces keep the same average speed: one starts at half of it
    and ends at one and a half times it, the other the reverse. */
const PACES: Record<Pace, (t: number) => number> = {
	steady: (t) => t,
	quickening: (t) => (t + t * t) / 2,
	slowing: (t) => 1 - PACES.quickening(1 - t),
}

type Point = readonly [x: number, y: number]

/** Where a connection runs in one layout: the corners it turns, ending at the
    tip of its arrowhead, and the centre of its label. */
type Route = { points: readonly Point[]; chip: Point }

/** A connection drawn and timed. */
type Flow = {
	d: string
	length: number
	/** The arrowhead's tip, and the direction it points in. */
	head: readonly [x: number, y: number, dx: number, dy: number]
	chip: Point
	/** The pulse's whole loop as one `linear()` easing: waiting before its
	    line, running it at its pace, then gone past the end. */
	timing: string
	/** When the pulse reaches the arrowhead, in seconds into the loop. */
	lands: number
}

type Flows = Record<EdgeKey, Flow>

/** Corners are quarter turns of this radius, drawn as one quadratic each. */
const CORNER = 10
const CORNER_LENGTH = 16.23
const HEAD = 8

/** A line through `points` with its corners rounded, stopping at the foot of
    the arrowhead whose tip is the last point. Every run is level or upright,
    so the length adds up without measuring. */
function draw(points: readonly Point[]) {
	const step = (from: Point, to: Point) =>
		[Math.sign(to[0] - from[0]), Math.sign(to[1] - from[1])] as const
	let d = `M${points[0]![0]} ${points[0]![1]}`
	let length = 0
	let into = step(points[0]!, points[1]!)

	for (let index = 1; index < points.length; index++) {
		const [x, y] = points[index]!
		const [px, py] = points[index - 1]!
		length += Math.abs(x - px) + Math.abs(y - py)
		into = step(points[index - 1]!, points[index]!)

		if (index === points.length - 1) {
			d += `L${x - into[0] * HEAD} ${y - into[1] * HEAD}`
			length -= HEAD
		} else {
			const out = step(points[index]!, points[index + 1]!)
			d += `L${x - into[0] * CORNER} ${y - into[1] * CORNER}Q${x} ${y} ${x + out[0] * CORNER} ${y + out[1] * CORNER}`
			length += CORNER_LENGTH - 2 * CORNER
		}
	}

	const [x, y] = points[points.length - 1]!
	return { d, length, head: [x, y, into[0], into[1]] as const }
}

function pacing(depart: number, run: number, pace: Pace) {
	const steps = pace === 'steady' ? 1 : 8
	const stops = Array.from({ length: steps + 1 }, (_, step) => {
		const t = step / steps
		const at = ((depart + t * run) / FLOW_LOOP) * 100
		return `${PACES[pace](t).toFixed(3)} ${at.toFixed(2)}%`
	})
	return `linear(0, ${stops.join(', ')}, 1)`
}

/**
 * Draws and times every connection of one layout. A pulse starts just short
 * of its line and ends just past it, so it runs the line plus its own length;
 * it has landed once its front reaches the arrowhead.
 */
function plan(routes: Record<EdgeKey, Route>): Flows {
	const flows = {} as Flows
	ARMS.forEach((arm, index) => {
		let clock = (index * FLOW_LOOP) / ARMS.length
		for (const key of arm) {
			const line = draw(routes[key].points)
			const run = (line.length + PULSE + 2) / FLOW_SPEED
			const lands = clock + (line.length + 1) / FLOW_SPEED
			flows[key] = {
				...line,
				chip: routes[key].chip,
				timing: pacing(clock, run, EDGES[key].pace),
				lands,
			}
			clock = lands + FLOW_DWELL
		}
	})
	return flows
}

const ends = (key: EdgeKey) => key.split('>') as [from: NodeKey, to: NodeKey]

/**
 * What stays lit while a box is hovered, as one attribute the stylesheet
 * matches against: a connection stays for either of its ends, a box for itself
 * and the boxes it is wired to.
 */
const edgeWith = (key: EdgeKey) => ends(key).join(' ')
const nodeWith = (node: NodeKey) =>
	[
		node,
		...EDGE_KEYS.flatMap((key) => {
			const [from, to] = ends(key)
			return from === node ? [to] : to === node ? [from] : []
		}),
	].join(' ')

/** The pulses that end at `node`: what tags each one's flash, and when it
    goes off. */
function landings(node: NodeKey, flows: Flows) {
	return EDGE_KEYS.filter((key) => ends(key)[1] === node).map((key) => ({
		key,
		'data-with': edgeWith(key),
		style: { animationDelay: `${flows[key].lands.toFixed(2)}s` },
	}))
}

/**
 * "What makes a Software Factory successful", Matt's alternate pitch: the
 * team builds infrastructure, which creates accelerators, which speed the
 * agent up; and it grows knowledge, which creates brakes, which slow the agent
 * down. Two arms from the team into the agent, every node, label and arrow as
 * he drew them.
 *
 * He drew it as a ring. The wide layout keeps that: the agent on top, the team
 * underneath, an arm up either side. Under 600px of column the same two arms
 * stand side by side as a ladder between the two players (a container query,
 * not a viewport one: the page gives the body a narrower column once the
 * pricing rail sits beside it). The brakes arm wears the gold, since it is the
 * one the pitch says to build first.
 *
 * Both drawings are `aria-hidden` and the same content is given once as text
 * for screen readers. Two layouts would otherwise read every label twice.
 *
 * The drawing moves, quietly: a pulse relays up one arm and then the other,
 * each box it reaches lights for a moment, and hovering a box keeps it and its
 * neighbours while the rest step back. All of it is CSS, in the
 * `SoftwareFactoryMap` block of `globals.css`, so this stays a server
 * component; what is here is the geometry and the timetable. The boxes are not
 * focusable, because they do nothing and sit in an `aria-hidden` drawing. With
 * reduced motion the moving layer is not rendered and the drawing is still.
 *
 * Sizes are written as SVG user units rather than composed from `TYPE`: they
 * scale with the drawing, so they are positions in it, not steps in the
 * page's type scale. The title is HTML and does use `TYPE`.
 */
export function SoftwareFactoryMap({ className }: { className?: string }) {
	return (
		<figure
			className={cn('ah-factory-map not-prose @container my-10', className)}
			style={FLOW_VARS}
		>
			<figcaption className={cn(TYPE.subhead, 'mb-7 text-balance text-center')}>
				What makes a Software Factory successful
			</figcaption>

			<Wide />
			<Narrow />

			<div className="sr-only">
				<p>
					Two paths run from the team to the agent. The Team builds
					Infrastructure, which creates Accelerators, which speed up The
					Agent. The Team grows Knowledge, which creates Brakes, which slow
					down The Agent.
				</p>
				<dl>
					{(['agent', 'team'] as const).map((key) => (
						<React.Fragment key={key}>
							<dt>{PLAYERS[key].title}</dt>
							<dd>{PLAYERS[key].wide.join(' ')}</dd>
						</React.Fragment>
					))}
					{(Object.keys(PARTS) as PartKey[]).map((key) => (
						<React.Fragment key={key}>
							<dt>{PARTS[key].title}</dt>
							<dd>{PARTS[key].wide.join(' ')}</dd>
						</React.Fragment>
					))}
				</dl>
			</div>
		</figure>
	)
}

const WIDE_SIZE = [680, 522] as const

/** The arms climb through the middle of their cards and turn in to the
    sides of the two players. */
const WIDE_FLOWS = plan({
	'team>knowledge': {
		points: [
			[258, 450],
			[168, 450],
			[168, 403],
		],
		chip: [218, 450],
	},
	'knowledge>brakes': {
		points: [
			[168, 300],
			[168, 231],
		],
		chip: [168, 266],
	},
	'brakes>agent': {
		points: [
			[168, 128],
			[168, 26],
			[255, 26],
		],
		chip: [168, 74],
	},
	'team>infrastructure': {
		points: [
			[422, 450],
			[512, 450],
			[512, 403],
		],
		chip: [462, 450],
	},
	'infrastructure>accelerators': {
		points: [
			[512, 300],
			[512, 231],
		],
		chip: [512, 266],
	},
	'accelerators>agent': {
		points: [
			[512, 128],
			[512, 26],
			[425, 26],
		],
		chip: [512, 74],
	},
})

/** From 600px of column: the ring. */
function Wide() {
	const [width, height] = WIDE_SIZE

	return (
		<div
			aria-hidden
			className="relative mx-auto hidden w-full max-w-[720px] @[600px]:block"
		>
			<BandFill x={24} y={112} width={288} height={304} of={WIDE_SIZE} accent />
			<BandFill x={368} y={112} width={288} height={304} of={WIDE_SIZE} />
			<svg
				viewBox={`0 0 ${width} ${height}`}
				className="relative block h-auto w-full"
			>
				<Edges flows={WIDE_FLOWS} />

				<Player player="agent" layout="wide" x={258} y={4} flows={WIDE_FLOWS} />
				<Player player="team" layout="wide" x={258} y={428} flows={WIDE_FLOWS} />

				<Part part="brakes" layout="wide" x={40} y={128} flows={WIDE_FLOWS} />
				<Part part="knowledge" layout="wide" x={40} y={300} flows={WIDE_FLOWS} />
				<Part part="accelerators" layout="wide" x={384} y={128} flows={WIDE_FLOWS} />
				<Part part="infrastructure" layout="wide" x={384} y={300} flows={WIDE_FLOWS} />
			</svg>
		</div>
	)
}

const NARROW_SIZE = [336, 675] as const

/** Straight up each column, from the team's card to the agent's. */
const NARROW_FLOWS = plan({
	'team>knowledge': {
		points: [
			[82, 565],
			[82, 503],
		],
		chip: [82, 533],
	},
	'knowledge>brakes': {
		points: [
			[82, 373],
			[82, 304],
		],
		chip: [82, 339],
	},
	'brakes>agent': {
		points: [
			[82, 174],
			[82, 113],
		],
		chip: [82, 143],
	},
	'team>infrastructure': {
		points: [
			[254, 565],
			[254, 503],
		],
		chip: [254, 533],
	},
	'infrastructure>accelerators': {
		points: [
			[254, 373],
			[254, 304],
		],
		chip: [254, 339],
	},
	'accelerators>agent': {
		points: [
			[254, 174],
			[254, 113],
		],
		chip: [254, 143],
	},
})

/**
 * Under 600px: the arms side by side between the two players, which become
 * full-width cards so that both arms can run straight into them. Two columns
 * leave a card about twenty characters of description a line, which is why
 * its breaks are set apart from the wide ones.
 */
function Narrow() {
	const [width, height] = NARROW_SIZE

	return (
		<div
			aria-hidden
			className="relative mx-auto w-full max-w-[400px] @[600px]:hidden"
		>
			<BandFill x={0} y={166} width={164} height={342} of={NARROW_SIZE} accent />
			<BandFill x={172} y={166} width={164} height={342} of={NARROW_SIZE} />
			<svg
				viewBox={`0 0 ${width} ${height}`}
				className="relative block h-auto w-full"
			>
				<Edges flows={NARROW_FLOWS} />

				<Player
					player="agent"
					layout="narrow"
					x={4}
					y={4}
					flows={NARROW_FLOWS}
				/>
				<Player
					player="team"
					layout="narrow"
					x={4}
					y={565}
					flows={NARROW_FLOWS}
				/>

				<Part part="brakes" layout="narrow" x={8} y={174} flows={NARROW_FLOWS} />
				<Part part="knowledge" layout="narrow" x={8} y={373} flows={NARROW_FLOWS} />
				<Part part="accelerators" layout="narrow" x={180} y={174} flows={NARROW_FLOWS} />
				<Part part="infrastructure" layout="narrow" x={180} y={373} flows={NARROW_FLOWS} />
			</svg>
		</div>
	)
}

/**
 * An arm's surface: a tinted, hatched band behind its two cards.
 *
 * It is an HTML box under the drawing rather than a `rect` in it, so that it
 * can wear `.bg-stripes`, the site's one hatch (`globals.css`), instead of a
 * second copy of that pattern redrawn as an SVG `pattern`. Inside this figure
 * the hatch is drawn at the slim divider's pitch, which the same stylesheet
 * sets. It is placed in percentages of the viewBox, so it tracks the drawing
 * at any width.
 *
 * The gold is a FILL here, which is the one way the accent is allowed to stay
 * gold in light mode (DESIGN rule 7). The border is mixed to an opaque colour
 * rather than given an alpha, like every stroke in the drawing: a translucent
 * edge sits half over its own fill and half over the page, and comes out
 * two-toned.
 */
function BandFill({
	x,
	y,
	width,
	height,
	of,
	accent,
}: {
	x: number
	y: number
	width: number
	height: number
	/** The viewBox size the band is positioned against. */
	of: readonly [width: number, height: number]
	accent?: boolean
}) {
	return (
		<div
			className={cn(
				'absolute overflow-hidden rounded-lg border',
				accent
					? 'bg-accent-fill/10 dark:bg-accent-fill/[0.05] border-[color:color-mix(in_oklab,var(--accent-fill)_50%,var(--background))] dark:border-[color:color-mix(in_oklab,var(--accent-fill)_25%,var(--background))]'
					: 'bg-foreground/[0.035] border-[color:color-mix(in_oklab,var(--foreground)_14%,var(--background))]',
			)}
			style={{
				left: `${(x / of[0]) * 100}%`,
				width: `${(width / of[0]) * 100}%`,
				top: `${(y / of[1]) * 100}%`,
				height: `${(height / of[1]) * 100}%`,
			}}
		>
			{/* The hatch is its own layer: on the same element as the tint,
			    tailwind-merge reads `bg-stripes` as a second background colour
			    and drops it. On the gold band it is re-inked gold, because the
			    default grey ink turns a pale yellow wash muddy. */}
			<div
				className={cn(
					'bg-stripes absolute inset-0',
					accent &&
						'[--stripes-ink:color-mix(in_oklch,var(--accent-fill)_24%,transparent)] dark:[--stripes-ink:color-mix(in_oklch,var(--accent-fill)_10%,transparent)]',
				)}
			/>
		</div>
	)
}

const PILL = { width: 164, height: 44, icon: 22, gap: 8 }

/**
 * The agent or the team: a solid ink pill, so the two players lead, with
 * Matt's line about them underneath.
 *
 * In the ring the pill is the box the lines meet. A pill that is already solid
 * ink cannot get brighter, so what lights there is a rim around it: the
 * flashes are drawn under the pill and its own rim is painted before its fill,
 * so only the outer half of either shows. In the ladder both arms have to
 * reach the player, so pill and line sit on a full-width card, and that card
 * is the box.
 */
function Player({
	player,
	layout,
	x,
	y,
	flows,
}: {
	player: PlayerKey
	layout: Layout
	x: number
	y: number
	flows: Flows
}) {
	const { title, Icon, advance } = PLAYERS[player]
	const card = layout === 'narrow'
	const width = card ? NARROW_SIZE[0] - 2 * x : PILL.width
	const pill = {
		x: x + (width - PILL.width) / 2,
		y: card ? y + 10 : y,
		width: PILL.width,
		height: PILL.height,
		rx: 9,
	}
	const box = card ? { x, y, width, height: 106, rx: 11 } : pill
	const pairX = pill.x + (PILL.width - (PILL.icon + PILL.gap + advance)) / 2
	const middle = pill.y + PILL.height / 2

	return (
		<g data-node={player} data-with={nodeWith(player)} data-rim={card ? undefined : ''}>
			{card ? (
				<rect
					{...box}
					className="ah-factory-box fill-card stroke-[color:color-mix(in_oklab,var(--foreground)_14%,var(--card))]"
				/>
			) : null}
			{landings(player, flows).map(({ key, ...flash }) => (
				<rect
					key={key}
					{...box}
					{...flash}
					fill="none"
					strokeWidth={card ? 2 : 4}
					className="ah-factory-flash stroke-[color:var(--factory-lit)]"
				/>
			))}
			<rect
				{...pill}
				strokeWidth={0}
				className={cn(
					'fill-foreground',
					!card &&
						'ah-factory-box stroke-[color:var(--factory-lit)] [paint-order:stroke]',
				)}
			/>
			<g
				transform={`translate(${pairX} ${middle - PILL.icon / 2}) scale(${PILL.icon / 24})`}
				className="text-background"
				fill="none"
				stroke="currentColor"
				strokeWidth={1.5}
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<Icon />
			</g>
			<text
				x={pairX + PILL.icon + PILL.gap}
				y={middle}
				textLength={advance}
				dominantBaseline="central"
				className="fill-background text-[15px] font-semibold tracking-[-0.01em]"
			>
				{title}
			</text>
			<text
				textAnchor="middle"
				className="ah-factory-type fill-[color:var(--ah-fg-muted)] text-[13px]"
			>
				{PLAYERS[player][layout].map((line, index) => (
					<tspan
						key={line}
						x={x + width / 2}
						y={pill.y + PILL.height + 22 + index * (card ? 17 : 18)}
					>
						{line}
					</tspan>
				))}
			</text>
		</g>
	)
}

/** Hugeicons "AI brain", drawn on a 24px grid. */
function AgentIcon() {
	return (
		<>
			<path d="M4 16.5001C4 18.1569 5.34315 19.5001 7 19.5001C7 20.8808 8.11929 22.0001 9.5 22.0001C10.8807 22.0001 12 20.8808 12 19.5001C12 20.8808 13.1193 22 14.5 22C15.8807 22 17 20.8807 17 19.5C18.6569 19.5 20 18.1569 20 16.5C20 15.9313 19.8418 15.3996 19.567 14.9465C20.9527 14.6814 22 13.463 22 12C22 10.537 20.9527 9.31855 19.567 9.0535C19.8418 8.60037 20 8.06866 20 7.5C20 5.84315 18.6569 4.5 17 4.5C17 3.11929 15.8807 2 14.5 2C13.1193 2 12 3.11938 12 4.50009C12 3.11938 10.8807 2.00009 9.5 2.00009C8.11929 2.00009 7 3.11938 7 4.50009C5.34315 4.50009 4 5.84324 4 7.50009C4 8.06876 4.15822 8.60046 4.43304 9.05359C3.04727 9.31865 2 10.5371 2 12.0001C2 13.4631 3.04727 14.6815 4.43304 14.9466C4.15822 15.3997 4 15.9314 4 16.5001Z" />
			<path d="M7.5 14.5L9.34189 8.97434C9.43631 8.69107 9.7014 8.5 10 8.5C10.2986 8.5 10.5637 8.69107 10.6581 8.97434L12.5 14.5M15.5 8.5V14.5M8.5 12.5H11.5" />
		</>
	)
}

/** Hugeicons "user group", drawn on a 24px grid. */
function TeamIcon() {
	return (
		<>
			<path d="M15 8C15 9.65685 13.6569 11 12 11C10.3431 11 9 9.65685 9 8C9 6.34315 10.3431 5 12 5C13.6569 5 15 6.34315 15 8Z" />
			<path d="M16 4C17.6569 4 19 5.34315 19 7C19 8.22309 18.2681 9.27523 17.2183 9.7423" />
			<path d="M13.7143 14H10.2857C7.91876 14 5.99998 15.9188 5.99998 18.2857C5.99998 19.2325 6.76749 20 7.71426 20H16.2857C17.2325 20 18 19.2325 18 18.2857C18 15.9188 16.0812 14 13.7143 14Z" />
			<path d="M17.7148 13C20.0818 13 22.0006 14.9188 22.0006 17.2857C22.0006 18.2325 21.233 19 20.2863 19" />
			<path d="M8 4C6.34315 4 5 5.34315 5 7C5 8.22309 5.73193 9.27523 6.78168 9.7423" />
			<path d="M3.71429 19C2.76751 19 2 18.2325 2 17.2857C2 14.9188 3.91878 13 6.28571 13" />
		</>
	)
}

/** A card's size, and where its type sits, in each layout. The two cards of
    a row share a height, so it is set by the row's longest description. */
const CARD = {
	wide: { width: 256, height: 100, inset: 16, title: 27, first: 47, leading: 18 },
	narrow: { width: 148, height: 127, inset: 12, title: 26, first: 45, leading: 17 },
}

/** One of the four things: a card holding its name and what it is. */
function Part({
	part,
	layout,
	x,
	y,
	flows,
}: {
	part: PartKey
	layout: Layout
	x: number
	y: number
	flows: Flows
}) {
	const { title, accent } = PARTS[part]
	const card = CARD[layout]
	const box = { x, y, width: card.width, height: card.height, rx: 11 }

	return (
		<g data-node={part} data-with={nodeWith(part)} data-accent={accent ? '' : undefined}>
			<rect
				{...box}
				className={cn(
					'ah-factory-box fill-card',
					accent
						? 'stroke-accent-fill dark:stroke-[color:color-mix(in_oklab,var(--accent-fill)_60%,var(--card))]'
						: 'stroke-[color:color-mix(in_oklab,var(--foreground)_14%,var(--card))]',
				)}
			/>
			{landings(part, flows).map(({ key, ...flash }) => (
				<rect
					key={key}
					{...box}
					{...flash}
					fill="none"
					strokeWidth={2}
					className="ah-factory-flash stroke-[color:var(--factory-lit)]"
				/>
			))}
			{/* The type is its own group so that a card can step back without
			    turning see-through over the hatch behind it. */}
			<g className="ah-factory-type">
				<text
					x={x + card.inset}
					y={y + card.title}
					className="fill-foreground text-[16px] font-bold tracking-[-0.018em]"
				>
					{title}
				</text>
				<text className="fill-[color:var(--ah-fg-muted)] text-[13px]">
					{PARTS[part][layout].map((line, index) => (
						<tspan
							key={line}
							x={x + card.inset}
							y={y + card.first + index * card.leading}
						>
							{line}
						</tspan>
					))}
				</text>
			</g>
		</g>
	)
}

/**
 * The connections, each with its label on it and, over it, everything that
 * moves along it: a pulse, one short dash run toward the arrowhead, and the
 * arrowhead again in full ink, which flashes as the pulse lands in it. The
 * label is drawn last, so a pulse passes under it.
 *
 * One ink for all of them, and it is OPAQUE: the foreground mixed into the
 * page colour, not the foreground at an alpha. A line runs on under its
 * arrowhead and crosses a band's border, and a translucent ink shows every
 * overlap as a brighter patch. The ink is `--factory-ink`, which a hover
 * swaps for a fainter one (`globals.css`).
 */
function Edges({ flows }: { flows: Flows }) {
	return (
		<g
			fill="none"
			stroke="currentColor"
			strokeWidth={1.5}
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			{EDGE_KEYS.map((key) => {
				const { d, length, head, chip, timing, lands } = flows[key]
				const [x, y, dx, dy] = head

				return (
					<g key={key} className="ah-factory-edge" data-with={edgeWith(key)}>
						<path d={d} />
						<Head x={x} y={y} dx={dx} dy={dy} />
						<path
							d={d}
							className="ah-factory-pulse text-foreground"
							style={
								{
									'--flow-length': `${length.toFixed(1)}px`,
									animationTimingFunction: timing,
								} as React.CSSProperties
							}
						/>
						<Head
							x={x}
							y={y}
							dx={dx}
							dy={dy}
							className="ah-factory-flash text-foreground"
							style={{ animationDelay: `${lands.toFixed(2)}s` }}
						/>
						<Chip x={chip[0]} y={chip[1]} label={EDGES[key].label} />
					</g>
				)
			})}
		</g>
	)
}

/** JetBrains Mono's advance at 11px: the font is monospaced, so a label's
    width follows from its length. */
const CHIP_CHAR = 6.6

/** A connection's label, on a small card of its own set into the line. Its
    border and type are the line's ink, so they step back with it. */
function Chip({ x, y, label }: { x: number; y: number; label: string }) {
	const width = label.length * CHIP_CHAR + 16

	return (
		<>
			<rect
				x={x - width / 2}
				y={y - 10}
				width={width}
				height={20}
				rx={6}
				strokeWidth={1}
				className="fill-card"
			/>
			<text
				x={x}
				y={y}
				textAnchor="middle"
				dominantBaseline="central"
				stroke="none"
				className="fill-current font-mono text-[11px] font-medium"
			>
				{label}
			</text>
		</>
	)
}

/** An arrowhead whose tip sits at (x, y), pointing along (dx, dy). */
function Head({
	x,
	y,
	dx,
	dy,
	...path
}: { x: number; y: number; dx: number; dy: number } & Omit<
	React.ComponentProps<'path'>,
	'd' | 'x' | 'y'
>) {
	const bx = x - dx * HEAD
	const by = y - dy * HEAD
	const d = `M${x} ${y}L${bx - dy * 4.5} ${by + dx * 4.5}L${bx + dy * 4.5} ${by - dx * 4.5}Z`

	return <path d={d} fill="currentColor" stroke="none" {...path} />
}
