import { BADGE_OUTLINE, TYPE } from '@/components/landing/type'
import { Box, Eye, ListTodo, Network } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

import { Centred } from '../centred'
import { hueStyle, LINE_INK, type BoardHue } from './hues'
import { GitPullRequestArrow } from './icons'

/** The five parts of a software factory, in Matt's order. */
const PARTS = [
	{
		id: 'tracker',
		Icon: ListTodo,
		name: 'Ticket Tracker',
		about: 'Where tasks are tracked and agent-human communication happens.',
	},
	{
		id: 'git',
		Icon: GitPullRequestArrow,
		name: 'Git Host',
		about: "Where your branches, PR's and reviews live.",
	},
	{
		id: 'runner',
		Icon: Box,
		name: 'Runner',
		about: 'The machine where your agents do their work.',
	},
	{
		id: 'orchestrator',
		Icon: Network,
		name: 'Orchestrator',
		about: 'Keeps track of your runners. It triggers them and handles errors.',
	},
	{
		id: 'observability',
		Icon: Eye,
		name: 'Observability Platform',
		about: 'Lets you see the entire factory to measure costs/success rates.',
	},
] as const

export type InfraPart = (typeof PARTS)[number]['id']

/** Matt's priorities for building them yourself, once he adds them. */
const PRIORITIES: Partial<Record<InfraPart, { label: string; hue: BoardHue }>> =
	{
		runner: { label: 'P1', hue: 'red' },
		orchestrator: { label: 'P1', hue: 'red' },
		observability: { label: 'P2', hue: 'amber' },
	}

export type InfraFrame = {
	/** How many parts are on the board yet, counted from the top. */
	parts: number
	/** Each part points right, at its pick or at the space left for one. */
	arrows?: boolean
	priorities?: boolean
	/** What fills each part, with Matt's note on why when he gives one. */
	picks?: Partial<Record<InfraPart, { name: string; note?: string }>>
	/** The other options under a pick, line by line as Matt breaks them. */
	alternatives?: { part: InfraPart; lines: readonly (readonly string[])[] }
}

/**
 * Matt's infrastructure board: the parts on the left, each pointing at what
 * fills it. He builds it up over a video, so every frame names which parts,
 * picks and notes were on screen when he grabbed it.
 */
export function InfraBoard({ frame }: { frame: InfraFrame }) {
	const parts = PARTS.slice(0, frame.parts)
	const board = frame.arrows || frame.picks
	return (
		<figure className="not-prose @container my-8">
			<Centred>
				<div
					className={cn(
						'grid gap-y-8 @2xl:gap-y-10',
						board
							? '@2xl:grid-cols-[minmax(0,1.1fr)_auto_minmax(0,0.9fr)] @2xl:gap-x-10'
							: 'mx-auto w-fit max-w-md',
					)}
				>
					{parts.map((part) => {
						const pick = frame.picks?.[part.id]
						const priority = frame.priorities ? PRIORITIES[part.id] : undefined
						const alternatives =
							frame.alternatives?.part === part.id
								? frame.alternatives.lines
								: null
						return (
							<div
								key={part.id}
								className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-2.5 @2xl:col-span-3 @2xl:grid-cols-subgrid @2xl:gap-x-10"
							>
								<div
									data-node={part.id}
									className="col-span-2 grid grid-cols-subgrid @2xl:col-span-1 @2xl:grid-cols-[1.75rem_minmax(0,1fr)] @2xl:gap-x-2.5"
								>
									<part.Icon
										aria-hidden
										className="text-foreground mt-0.5 size-6"
									/>
									<div>
										<p className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
											<span className={TYPE.subhead}>{part.name}</span>
											{priority ? (
												<span
													className={cn(
														TYPE.badge,
														BADGE_OUTLINE,
														'border-2 border-(--edge) text-(--ink)',
													)}
													style={hueStyle(priority.hue)}
												>
													{priority.label}
												</span>
											) : null}
										</p>
										<p
											className={cn(
												TYPE.metaProse,
												'text-muted-foreground mt-1 text-pretty',
											)}
										>
											{part.about}
										</p>
									</div>
								</div>
								{board ? (
									<div className="col-start-2 mt-3 flex items-start gap-3 @2xl:contents">
										<Arrow
											edge={`${part.id}-${part.id}-pick`}
											className="mt-2 shrink-0 @2xl:mt-[0.9rem]"
										/>
										<div
											data-node={`${part.id}-pick`}
											className="min-w-0 @2xl:mt-1.5"
										>
											{pick ? (
												<>
													<p className={cn(TYPE.subhead, 'text-pretty')}>
														<span className="sr-only">{part.name}: </span>
														{pick.name}
													</p>
													{pick.note ? (
														<p
															className={cn(
																TYPE.metaProse,
																'text-muted-foreground mt-1 text-pretty',
															)}
														>
															{pick.note}
														</p>
													) : null}
												</>
											) : null}
											{alternatives ? (
												<ul
													aria-label="Alternatives"
													className="mt-6 space-y-3"
												>
													{alternatives.map((line) => (
														<li
															key={line.join()}
															className="flex flex-wrap gap-x-6 gap-y-3"
														>
															{line.map((name) => (
																<span key={name} className={TYPE.cardTitle}>
																	{name}
																</span>
															))}
														</li>
													))}
												</ul>
											) : null}
										</div>
									</div>
								) : null}
							</div>
						)
					})}
				</div>
			</Centred>
		</figure>
	)
}

/** Matt's plain right arrow from a part to its pick. On a phone the pick sits
    under the part, and the arrow leads into it from there. */
function Arrow({ edge, className }: { edge: string; className?: string }) {
	return (
		<svg
			aria-hidden
			viewBox="0 0 64 12"
			className={cn(LINE_INK, 'h-3 w-10 @2xl:w-16', className)}
			preserveAspectRatio="xMinYMid meet"
		>
			<path
				data-edge={edge}
				d="M2 6h58M54 1.5 60 6l-6 4.5"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	)
}
