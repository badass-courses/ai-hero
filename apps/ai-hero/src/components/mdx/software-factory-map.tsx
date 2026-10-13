import * as React from 'react'
import { TYPE } from '@/components/landing/type'

import { cn } from '@coursebuilder/ui/utils/cn'

/**
 * The four things a Software Factory is made of. Each description is broken
 * by hand, once per layout, because SVG text does not wrap.
 */
const PARTS = {
	systems: {
		title: 'the systems',
		wide: ['engineering loop, skills,', 'orchestration, testing,', 'automated reviews'],
		narrow: ['engineering loop, skills, orchestration,', 'testing, automated reviews'],
	},
	environment: {
		title: 'the environment',
		wide: ['codebase, data, tests, tools', '"the agent\'s environment"'],
		narrow: ['codebase, data, tests, tools', '"the agent\'s environment"'],
	},
	knowledge: {
		title: 'knowledge',
		wide: ['terminology, goals,', 'domain expertise'],
		narrow: ['terminology, goals,', 'domain expertise'],
	},
	practices: {
		title: 'practices',
		wide: ['design, planning, reviews,', 'maintenance, engineering discipline'],
		narrow: ['design, planning, reviews, maintenance,', 'engineering discipline'],
	},
} as const

type PartKey = keyof typeof PARTS

const LAYERS = [
	{ label: 'Env + Process layer', parts: ['systems', 'environment'] },
	{ label: 'Strategic layer', parts: ['knowledge', 'practices'] },
] as const satisfies readonly { label: string; parts: readonly PartKey[] }[]

type NodeKey = PartKey | 'agent' | 'team'
type Dir = 'up' | 'down' | 'left' | 'right'

/**
 * What moves. A pulse travels each connection toward its arrowhead, so there
 * is one row per arrowhead and a two-way line gets two. The number is when the
 * pulse sets off, in seconds into the loop.
 *
 * The loop is two turns with a rest after each. The agent works through its
 * four things and reaches the team; then the team does the same, and the
 * systems and the knowledge answer the agent. Within a turn the right-hand
 * lines trail the left by a beat: a mirrored burst is the one thing here that
 * would pull the eye off the copy.
 */
const DEPARTS = {
	'agent>systems': 0,
	'agent>knowledge': 0,
	'agent>environment': 0.4,
	'agent>practices': 0.4,
	'agent>team': 0.8,
	'team>systems': 6,
	'team>knowledge': 6,
	'team>environment': 6.4,
	'team>practices': 6.4,
	'team>agent': 6.8,
	'systems>agent': 7.6,
	'knowledge>agent': 7.6,
} as const satisfies Partial<Record<`${NodeKey}>${NodeKey}`, number>>

type FlowKey = keyof typeof DEPARTS

const FLOW_KEYS = Object.keys(DEPARTS) as FlowKey[]

/** The loop in seconds, and a pulse's speed in SVG user units a second. */
const FLOW_LOOP = 12
const FLOW_SPEED = 140

/**
 * The same two numbers as `globals.css` wants them: how long the loop is, and
 * how far a pulse gets in one. Every pulse moves that far every loop whatever
 * the length of its line, which is what keeps them all at one speed.
 */
const FLOW_VARS = {
	'--flow-loop': `${FLOW_LOOP}s`,
	'--flow-travel': `${FLOW_LOOP * FLOW_SPEED}px`,
} as React.CSSProperties

/** One flow, as one of the two layouts draws it. */
type FlowLine = {
	/** Its line, from where it starts to the foot of its arrowhead. It retraces
	    a line of the drawing, so the two have to move together. */
	d: string
	/** That line's length in user units, as `getTotalLength()` reports it. It
	    times the flash at the far end. */
	length: number
	/** The arrowhead it runs into. */
	head: readonly [x: number, y: number, dir: Dir]
}

type FlowLines = Record<FlowKey, FlowLine>

const WIDE_FLOWS: FlowLines = {
	'agent>systems': { d: 'M248 26H220V108', length: 110, head: [220, 115, 'down'] },
	'agent>knowledge': {
		d: 'M248 26H26Q16 26 16 36V321Q16 331 26 331H30',
		length: 543,
		head: [37, 331, 'right'],
	},
	'agent>environment': { d: 'M422 26H460V108', length: 120, head: [460, 115, 'down'] },
	'agent>practices': {
		d: 'M422 26H654Q664 26 664 36V321Q664 331 654 331H650',
		length: 553,
		head: [643, 331, 'left'],
	},
	'agent>team': { d: 'M340 58V420', length: 362, head: [340, 427, 'down'] },
	'team>systems': {
		d: 'M318 430V254Q318 244 308 244H260Q250 244 250 234V224',
		length: 266,
		head: [250, 217, 'up'],
	},
	'team>knowledge': {
		d: 'M258 452H178Q168 452 168 442V380',
		length: 158,
		head: [168, 373, 'up'],
	},
	'team>environment': {
		d: 'M362 430V254Q362 244 372 244H420Q430 244 430 234V224',
		length: 266,
		head: [430, 217, 'up'],
	},
	'team>practices': {
		d: 'M422 452H502Q512 452 512 442V380',
		length: 158,
		head: [512, 373, 'up'],
	},
	'team>agent': { d: 'M340 420V58', length: 362, head: [340, 51, 'up'] },
	'systems>agent': { d: 'M220 108V26H248', length: 110, head: [255, 26, 'right'] },
	'knowledge>agent': {
		d: 'M30 331H26Q16 331 16 321V36Q16 26 26 26H248',
		length: 543,
		head: [255, 26, 'right'],
	},
}

const NARROW_FLOWS: FlowLines = {
	'agent>systems': {
		d: 'M88 26H22Q12 26 12 36V145H22',
		length: 201,
		head: [29, 145, 'right'],
	},
	'agent>knowledge': {
		d: 'M88 26H22Q12 26 12 36V375H22',
		length: 431,
		head: [29, 375, 'right'],
	},
	'agent>environment': {
		d: 'M88 26H22Q12 26 12 36V233H22',
		length: 289,
		head: [29, 233, 'right'],
	},
	'agent>practices': {
		d: 'M88 26H22Q12 26 12 36V453Q12 463 22 463',
		length: 515,
		head: [29, 463, 'right'],
	},
	'agent>team': {
		d: 'M272 26H338Q348 26 348 36V554Q348 564 338 564H272',
		length: 682,
		head: [265, 564, 'left'],
	},
	'team>systems': {
		d: 'M272 564H338Q348 564 348 554V145H338',
		length: 501,
		head: [331, 145, 'left'],
	},
	'team>knowledge': {
		d: 'M272 564H338Q348 564 348 554V375H338',
		length: 271,
		head: [331, 375, 'left'],
	},
	'team>environment': {
		d: 'M272 564H338Q348 564 348 554V233H338',
		length: 413,
		head: [331, 233, 'left'],
	},
	'team>practices': {
		d: 'M272 564H338Q348 564 348 554V463H338',
		length: 183,
		head: [331, 463, 'left'],
	},
	'team>agent': {
		d: 'M272 564H338Q348 564 348 554V36Q348 26 338 26H272',
		length: 682,
		head: [265, 26, 'left'],
	},
	'systems>agent': {
		d: 'M22 145H12V36Q12 26 22 26H88',
		length: 201,
		head: [95, 26, 'right'],
	},
	'knowledge>agent': {
		d: 'M22 375H12V36Q12 26 22 26H88',
		length: 431,
		head: [95, 26, 'right'],
	},
}

const flowEnds = (key: FlowKey) => key.split('>') as [from: NodeKey, to: NodeKey]

/** A flow's two ends as one attribute, which is how the stylesheet tells whose
    it is when a box is hovered. */
const flowTag = (key: FlowKey) => flowEnds(key).join(' ')

const isPart = (node: NodeKey): node is PartKey => node in PARTS

/** The moment a pulse reaches its arrowhead, as an `animation-delay`. */
const landsAt = (key: FlowKey, flows: FlowLines) =>
	`${(DEPARTS[key] + flows[key].length / FLOW_SPEED).toFixed(2)}s`

/** The pulses that end at `node`: what tags each one's flash, and when it
    goes off. */
function landings(node: NodeKey, flows: FlowLines) {
	return FLOW_KEYS.filter((key) => flowEnds(key)[1] === node).map((key) => ({
		key,
		'data-flow': flowTag(key),
		style: { animationDelay: landsAt(key, flows) },
	}))
}

/**
 * "What goes into making a Software Factory successful": two players, the
 * agent and the team, each wired to the four things they work through, which
 * sit in two layers.
 *
 * It redraws the cohort page's hand-drawn PNG as inline SVG. The PNG had one
 * background, so the dark theme got a white slab, and at phone width its
 * labels came out around 4px. Here every colour is a token, the type is the
 * page's own, and there are two layouts picked by the width of the column
 * (a container query, not a viewport one: the same page gives the body a
 * narrower column once the pricing rail sits beside it).
 *
 * Every connection in the original is kept, arrowheads included: the agent's
 * line carries a head back into the agent on the systems and knowledge side
 * only. What changes is the routing. The original crossed its lines over the
 * middle; here the agent's lines leave from its sides and the team's from its
 * top and sides, so nothing crosses.
 *
 * Both drawings are `aria-hidden` and the same content is given once as text
 * for screen readers. Two layouts would otherwise read every label twice.
 *
 * The drawing moves, quietly: a pulse runs each connection toward its
 * arrowhead, the box it reaches lights for a moment, and hovering a box keeps
 * its own connections while the rest step back. All of it is CSS, in the
 * `SoftwareFactoryMap` block of `globals.css`, so this stays a server
 * component. What is here is the geometry and the timetable (`DEPARTS`,
 * `Flows`); the boxes are not focusable, because they do nothing and sit in
 * an `aria-hidden` drawing. With reduced motion the whole layer is not
 * rendered and the drawing is the still one.
 *
 * Sizes are written as SVG user units rather than composed from `TYPE`: they
 * scale with the drawing, so they are positions in it, not steps in the
 * page's type scale. The title and the caption are HTML and do use `TYPE`.
 */
export function SoftwareFactoryMap({ className }: { className?: string }) {
	return (
		<figure
			className={cn('ah-factory-map not-prose @container my-10', className)}
			style={FLOW_VARS}
		>
			<p className={cn(TYPE.subhead, 'mb-7 text-balance text-center')}>
				What goes into making a Software Factory successful
			</p>

			<Wide />
			<Narrow />

			<div className="sr-only">
				<p>
					Two players, the agent and the team, are each connected to four
					things, and to each other.
				</p>
				<dl>
					{LAYERS.map((layer) => (
						<React.Fragment key={layer.label}>
							<dt>{layer.label}</dt>
							{layer.parts.map((key) => (
								<dd key={key}>
									{PARTS[key].title}: {PARTS[key].wide.join(' ')}
								</dd>
							))}
						</React.Fragment>
					))}
				</dl>
			</div>

			<figcaption
				className={cn(
					TYPE.metaProse,
					'mt-5 text-center text-[color:var(--ah-fg-muted)]',
				)}
			>
				<span className="block">humans on the same page as the agent</span>
				<span className="block">humans on the same page as each other</span>
				<span className="block text-balance">
					using the same knowledge &amp; practices &amp; systems
				</span>
			</figcaption>
		</figure>
	)
}

/** From 600px of column: the two-column drawing, players top and bottom. */
function Wide() {
	return (
		<div
			aria-hidden
			className="relative mx-auto hidden w-full max-w-[720px] @[600px]:block"
		>
			<BandFill y={84} height={146} of={478} />
			<BandFill y={258} height={128} of={478} accent />
			<svg viewBox="0 0 680 478" className="relative block h-auto w-full">
				<BandLabel x={56} y={84} label={LAYERS[0].label} />
				<BandLabel x={56} y={258} label={LAYERS[1].label} accent />

				<Edges>
					<Lines of="agent">
						{/* The agent's left line: back into the agent, down into the
						    systems, and round the outside into knowledge. */}
						<path d="M248 26H26Q16 26 16 36V321Q16 331 26 331H30" />
						<Head x={255} y={26} dir="right" />
						<Head x={37} y={331} dir="right" />
						<path d="M220 26V108" />
						<Head x={220} y={115} dir="down" />

						{/* Its right line: into the environment, and round into practices. */}
						<path d="M422 26H654Q664 26 664 36V321Q664 331 654 331H650" />
						<Head x={643} y={331} dir="left" />
						<path d="M460 26V108" />
						<Head x={460} y={115} dir="down" />
					</Lines>

					<Lines of="team">
						{/* The team: up the middle to the systems and the environment... */}
						<path d="M318 430V254Q318 244 308 244H260Q250 244 250 234V224" />
						<Head x={250} y={217} dir="up" />
						<path d="M362 430V254Q362 244 372 244H420Q430 244 430 234V224" />
						<Head x={430} y={217} dir="up" />

						{/* ...and out of its sides to knowledge and practices. */}
						<path d="M258 452H178Q168 452 168 442V380" />
						<Head x={168} y={373} dir="up" />
						<path d="M422 452H502Q512 452 512 442V380" />
						<Head x={512} y={373} dir="up" />
					</Lines>

					{/* The agent and the team, to each other. */}
					<Lines>
						<path d="M340 58V420" />
						<Head x={340} y={51} dir="up" />
						<Head x={340} y={427} dir="down" />
					</Lines>

					<Flows flows={WIDE_FLOWS} />
				</Edges>

				<Player x={258} y={4} width={164} player="agent" flows={WIDE_FLOWS} />
				<Player x={258} y={430} width={164} player="team" flows={WIDE_FLOWS} />

				<Part
					x={40}
					y={118}
					width={256}
					height={96}
					part="systems"
					lines="wide"
					flows={WIDE_FLOWS}
				/>
				<Part
					x={384}
					y={118}
					width={256}
					height={96}
					part="environment"
					lines="wide"
					flows={WIDE_FLOWS}
				/>
				<Part
					x={40}
					y={292}
					width={256}
					height={78}
					part="knowledge"
					lines="wide"
					flows={WIDE_FLOWS}
					accent
				/>
				<Part
					x={384}
					y={292}
					width={256}
					height={78}
					part="practices"
					lines="wide"
					flows={WIDE_FLOWS}
					accent
				/>
			</svg>
		</div>
	)
}

/**
 * Under 600px: one column. Two columns of cards would leave each about
 * twenty characters wide. The agent's connections run down the left edge and
 * the team's up the right, where the team's line carries on to the agent.
 */
function Narrow() {
	const rows: { part: PartKey; y: number; accent?: boolean }[] = [
		{ part: 'systems', y: 106 },
		{ part: 'environment', y: 194 },
		{ part: 'knowledge', y: 336, accent: true },
		{ part: 'practices', y: 424, accent: true },
	]

	return (
		<div
			aria-hidden
			className="relative mx-auto w-full max-w-[420px] @[600px]:hidden"
		>
			<BandFill y={72} height={214} of={590} />
			<BandFill y={302} height={214} of={590} accent />
			<svg viewBox="0 0 360 590" className="relative block h-auto w-full">
				<BandLabel x={48} y={72} label={LAYERS[0].label} large />
				<BandLabel x={48} y={302} label={LAYERS[1].label} accent large />

				<Edges>
					<Lines of="agent">
						<path d="M88 26H22Q12 26 12 36V453Q12 463 22 463" />
						<Head x={95} y={26} dir="right" />
						{rows.map(({ part, y }) => (
							<React.Fragment key={part}>
								{/* The last agent branch is the end of its line, drawn above. */}
								{part === 'practices' ? null : <path d={`M12 ${y + 39}H22`} />}
								<Head x={29} y={y + 39} dir="right" />
							</React.Fragment>
						))}
					</Lines>

					<Lines of="team">
						{rows.map(({ part, y }) => (
							<React.Fragment key={part}>
								<path d={`M348 ${y + 39}H338`} />
								<Head x={331} y={y + 39} dir="left" />
							</React.Fragment>
						))}
					</Lines>

					{/* The team's trunk is also its line to the agent, so it belongs to
					    both. Drawn after the team's branches: they start on it, and a
					    branch that has stepped back would otherwise notch it. */}
					<Lines>
						<path d="M272 564H338Q348 564 348 554V36Q348 26 338 26H272" />
						<Head x={265} y={564} dir="left" />
						<Head x={265} y={26} dir="left" />
					</Lines>

					<Flows flows={NARROW_FLOWS} />
				</Edges>

				<Player
					x={98}
					y={4}
					width={164}
					player="agent"
					flows={NARROW_FLOWS}
					large
				/>
				<Player
					x={98}
					y={542}
					width={164}
					player="team"
					flows={NARROW_FLOWS}
					large
				/>

				{rows.map(({ part, y, accent }) => (
					<Part
						key={part}
						x={32}
						y={y}
						width={296}
						height={78}
						part={part}
						lines="narrow"
						flows={NARROW_FLOWS}
						accent={accent}
					/>
				))}
			</svg>
		</div>
	)
}

/**
 * A layer's surface: a tinted, hatched band.
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
	y,
	height,
	of,
	accent,
}: {
	y: number
	height: number
	/** The viewBox height the band is positioned against. */
	of: number
	accent?: boolean
}) {
	return (
		<div
			className={cn(
				'absolute inset-x-0 overflow-hidden rounded-lg border',
				accent
					? 'bg-accent-fill/10 dark:bg-accent-fill/[0.05] border-[color:color-mix(in_oklab,var(--accent-fill)_50%,var(--background))] dark:border-[color:color-mix(in_oklab,var(--accent-fill)_25%,var(--background))]'
					: 'bg-foreground/[0.035] border-[color:color-mix(in_oklab,var(--foreground)_14%,var(--background))]',
			)}
			style={{ top: `${(y / of) * 100}%`, height: `${(height / of) * 100}%` }}
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

/** A layer's name, in the top-left corner of its band. */
function BandLabel({
	x,
	y,
	label,
	accent,
	large,
}: {
	x: number
	/** The top of the band the label belongs to. */
	y: number
	label: string
	accent?: boolean
	large?: boolean
}) {
	return (
		<text
			x={x}
			y={y + 22}
			className={cn(
				'font-mono font-medium',
				large ? 'text-[12px]' : 'text-[11px]',
				accent ? 'fill-primary' : 'fill-muted-foreground',
			)}
		>
			{label}
		</text>
	)
}

/**
 * The two players. `advance` is the label's width in each drawing's units:
 * SVG has no layout, so centring an icon and a label as one pair means
 * knowing how wide the label is. It is also set as the label's `textLength`,
 * which makes the number true even when a fallback font is in use.
 */
const PLAYERS = {
	agent: { label: 'the agent', Icon: AgentIcon, advance: { wide: 68, narrow: 72.5 } },
	team: { label: 'the team', Icon: TeamIcon, advance: { wide: 64, narrow: 68.5 } },
} as const

const PLAYER_ICON = 22
const PLAYER_GAP = 8

/**
 * The agent or the team: a solid ink block, so the two hubs lead.
 *
 * A block that is already solid ink cannot get brighter, so what lights is a
 * rim around it. The flashes are drawn under the block and the block's own
 * rim is painted before its fill, so only the outer half of either shows.
 */
function Player({
	x,
	y,
	width,
	player,
	flows,
	large,
}: {
	x: number
	y: number
	width: number
	player: keyof typeof PLAYERS
	flows: FlowLines
	large?: boolean
}) {
	const { label, Icon, advance } = PLAYERS[player]
	const labelWidth = large ? advance.narrow : advance.wide
	const pairX = x + (width - (PLAYER_ICON + PLAYER_GAP + labelWidth)) / 2
	const box = { x, y, width, height: 44, rx: 9 }

	return (
		<g data-node={player}>
			{landings(player, flows).map(({ key, ...flash }) => (
				<rect
					key={key}
					{...box}
					{...flash}
					fill="none"
					strokeWidth={4}
					className="ah-factory-flash stroke-[color:var(--factory-lit)]"
				/>
			))}
			<rect
				{...box}
				strokeWidth={0}
				className="ah-factory-box fill-foreground stroke-[color:var(--factory-lit)] [paint-order:stroke]"
			/>
			<g
				transform={`translate(${pairX} ${y + 22 - PLAYER_ICON / 2}) scale(${PLAYER_ICON / 24})`}
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
				x={pairX + PLAYER_ICON + PLAYER_GAP}
				y={y + 22}
				textLength={labelWidth}
				dominantBaseline="central"
				className={cn(
					'fill-background font-semibold tracking-[-0.01em]',
					large ? 'text-[16px]' : 'text-[15px]',
				)}
			>
				{label}
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

/** One of the four things: a card holding its name and what it covers. */
function Part({
	x,
	y,
	width,
	height,
	part,
	lines,
	flows,
	accent,
}: {
	x: number
	y: number
	width: number
	height: number
	part: PartKey
	lines: 'wide' | 'narrow'
	flows: FlowLines
	accent?: boolean
}) {
	// The one-column drawing is shown below its viewBox size on a phone, so its
	// type is drawn a step larger to land where the wide drawing's does.
	const large = lines === 'narrow'
	const box = { x, y, width, height, rx: 11 }

	return (
		<g data-node={part} data-part="" data-accent={accent ? '' : undefined}>
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
					x={x + 16}
					y={y + (large ? 28 : 27)}
					className={cn(
						'fill-foreground font-bold tracking-[-0.018em]',
						large ? 'text-[17px]' : 'text-[16px]',
					)}
				>
					{PARTS[part].title}
				</text>
				<text
					className={cn(
						'fill-[color:var(--ah-fg-muted)]',
						large ? 'text-[14px]' : 'text-[13px]',
					)}
				>
					{PARTS[part][lines].map((line, index) => (
						<tspan
							key={line}
							x={x + 16}
							y={y + (large ? 49 + index * 19 : 47 + index * 18)}
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
 * The connections. One ink for all of them, as in the original.
 *
 * The ink is OPAQUE: the foreground mixed into the page colour, not the
 * foreground at an alpha. A line runs on under its arrowhead, branches start
 * on top of their trunk, and lines cross the bands' borders, and a
 * translucent ink shows every one of those overlaps as a brighter patch.
 */
function Edges({ children }: { children: React.ReactNode }) {
	return (
		<g
			className="text-[color:color-mix(in_oklab,var(--foreground)_58%,var(--background))]"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.5}
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			{children}
		</g>
	)
}

/**
 * The lines that belong to one player, or to both when `of` is left out, so
 * that hovering a player can keep its own lines and let the other's step back.
 * They step back by changing ink, not by fading, for the reason `Edges` gives.
 */
function Lines({
	of,
	children,
}: {
	of?: 'agent' | 'team'
	children: React.ReactNode
}) {
	return (
		<g className="ah-factory-lines" data-of={of}>
			{children}
		</g>
	)
}

/**
 * Everything that moves along the lines, drawn over them in three passes.
 *
 * First a still copy of each part's own connections, hidden until that part is
 * hovered: the lines under it have all stepped back by then, and a line that
 * is shared cannot be half one ink and half another. A return flow adds only
 * its arrowhead, since its line is the outbound one. Two copies of one stroke
 * would thicken its soft edge.
 *
 * Then the pulses, one short dash per flow, and last the arrowheads again in
 * full ink, each of which flashes as its pulse lands in it.
 */
function Flows({ flows }: { flows: FlowLines }) {
	return (
		<>
			{FLOW_KEYS.map((key) => {
				const [from, to] = flowEnds(key)
				if (!isPart(from) && !isPart(to)) return null
				const [x, y, dir] = flows[key].head

				return (
					<g key={key} className="ah-factory-link" data-flow={flowTag(key)}>
						{isPart(to) ? <path d={flows[key].d} /> : null}
						<Head x={x} y={y} dir={dir} />
					</g>
				)
			})}
			{FLOW_KEYS.map((key) => (
				<path
					key={key}
					d={flows[key].d}
					className="ah-factory-pulse text-foreground"
					data-flow={flowTag(key)}
					style={{ animationDelay: `${DEPARTS[key]}s` }}
				/>
			))}
			{FLOW_KEYS.map((key) => {
				const [x, y, dir] = flows[key].head

				return (
					<Head
						key={key}
						x={x}
						y={y}
						dir={dir}
						className="ah-factory-flash text-foreground"
						data-flow={flowTag(key)}
						style={{ animationDelay: landsAt(key, flows) }}
					/>
				)
			})}
		</>
	)
}

/** An arrowhead whose tip sits at (x, y). */
function Head({
	x,
	y,
	dir,
	...path
}: { x: number; y: number; dir: Dir } & Omit<
	React.ComponentProps<'path'>,
	'd' | 'x' | 'y'
>) {
	const d = {
		right: `M${x} ${y}l-8 -4.5v9z`,
		left: `M${x} ${y}l8 -4.5v9z`,
		down: `M${x} ${y}l-4.5 -8h9z`,
		up: `M${x} ${y}l-4.5 8h9z`,
	}[dir]

	return <path d={d} fill="currentColor" stroke="none" {...path} />
}
