'use client'

import * as React from 'react'
import {
	Message,
	MessageContent,
	MessageResponse,
} from '@/components/ai-elements/message'
import { Tool, ToolContent } from '@/components/ai-elements/tool'
import { TYPE } from '@/components/landing/type'
import { Button } from '@/components/ui/button'
import { CollapsibleTrigger } from '@/components/ui/collapsible'
import { useMuxPlayer } from '@/hooks/use-mux-player'
import { keepCaptionCuesLoading } from '@/hooks/use-mux-player-prefs'
import {
	contentWords,
	activeRowIndex,
	rowsOnScreen,
	sessionExtractRows,
	spokenBlockIndex,
	type SessionExtract,
	type SessionExtractRow,
} from '@/lib/session-extract'
import { skillKey } from '@ai-hero/learner-agent/views'
import type { MuxPlayerRefAttributes } from '@mux/mux-player-react'
import {
	ArrowDownIcon,
	ArrowUpIcon,
	ChevronDownIcon,
	PictureInPicture2,
	SparklesIcon,
	Terminal,
	WrenchIcon,
	XCircleIcon,
} from 'lucide-react'

import { Tabs, TabsContent } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

import {
	formatTime,
	seekPlayer,
	usePlayerTime,
	type PlayerRef,
} from './session-player-time'
import {
	SESSION_PROSE,
	SessionMomentList,
	SessionViewTabs,
	SkillPageLink,
	TimeButton,
	useSessionViews,
	type SessionTab,
} from './session-views'

/** Seconds of captions that count as "what Matt is saying now". */
const SPOKEN_WINDOW = 6
/** Replies (newest first) searched for the block he is talking about. */
const SPOKEN_REPLIES = 2
/** Where the anchor block sits below the panel's top edge, in px. */
const ANCHOR_OFFSET = 48
/** How far down the panel a new entry is revealed, as a share of its height. */
const REVEAL_AT = 0.6
/** Seconds a match outlives the captions that made it, across a pause to riff. */
const SPOKEN_HOLD = 8
const BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, tr'

/**
 * Lists as the site sets them (`.ah-bullets`, `.ah-numbers`), at the panel's
 * size: a hanging indent so a wrapped line lines up with the text above it,
 * a 5px gold dot centred on the first line, and a faint mono numeral.
 * Streamdown's own lists sit inside their markers with padded items.
 */
const LIST_TYPE = cn(
	'[&_li]:my-0 [&_li]:py-0 [&_li+li]:mt-1 [&_li_:is(ul,ol)]:mt-1 [&_li_:is(ul,ol)]:mb-0',
	'[&_ul]:list-none [&_ul]:pl-0 [&_ul>li]:relative [&_ul>li]:pl-[15px]',
	"[&_ul>li]:before:bg-primary [&_ul>li]:before:absolute [&_ul>li]:before:top-[calc((1.625em_-_5px)/2)] [&_ul>li]:before:left-0 [&_ul>li]:before:size-[5px] [&_ul>li]:before:rounded-full [&_ul>li]:before:opacity-70 [&_ul>li]:before:content-['']",
	'[&_ol]:list-outside [&_ol]:pl-[18px] [&_ol>li]:pl-[3px] [&_ol>li]:marker:font-mono [&_ol>li]:marker:text-[0.86em] [&_ol>li]:marker:text-[var(--ah-fg-faint)]',
)

/**
 * Tables at the reply's size: Streamdown sets its cells in `text-sm` with
 * page-sized padding, a step larger than the text around them.
 */
const TABLE_TYPE =
	'[&_:is(th,td)]:px-2.5 [&_:is(th,td)]:py-1.5 [&_:is(th,td)]:text-[1em] [&_td]:align-top'

/**
 * Markdown inside the panel: mono runs a size down (a mono face reads larger
 * than the sans beside it) on a translucent chip, so the spoken highlight
 * shows through code instead of stopping at it. Headings the agent writes
 * stay near the text size; at the renderer's page sizes (up to 30px) they
 * shouted over the reply around them.
 */
const REPLY_TYPE = cn(
	SESSION_PROSE,
	'[&_:is(h1,h2,h3)]:text-[1.08em] [&_:is(h4,h5,h6)]:text-[1em] [&_:is(h1,h2,h3,h4,h5,h6)]:mb-1 [&_:is(h1,h2,h3,h4,h5,h6)]:mt-3',
	'[&_:not(pre)>code]:bg-foreground/[0.07] [&_:not(pre)>code]:rounded-[4px] [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-px [&_:not(pre)>code]:text-[0.86em] [&_:not(pre)>code]:font-normal',
	'[&_hr]:my-3 [&_ol]:my-2 [&_p]:my-1.5 [&_ul]:my-2',
	LIST_TYPE,
	TABLE_TYPE,
)

/**
 * Expanded call detail (a skill's injected text): reference, not the
 * conversation, so a step smaller and dimmer, wrapped in full with no scroll
 * box of its own.
 */
const DETAIL_TYPE = cn(
	REPLY_TYPE,
	'text-muted-foreground text-[0.93em] [overflow-wrap:anywhere] [&_strong]:text-foreground/80 [&_:is(h1,h2,h3,h4)]:text-[1em]',
)

/**
 * The agent session the video drives on screen. Live, its first tab, reveals
 * it in step with the player; the other tabs list its prompts, skills,
 * corrections and errors whole (`session-views.tsx`). It fills its parent's
 * height.
 */
export function SessionExtractPanel({
	extract,
	skillLinks,
	className,
	onPopOut,
}: {
	extract: SessionExtract
	/** Skill pages by `skillKey`, linked from Live and the Skills tab. */
	skillLinks?: Readonly<Record<string, string>>
	className?: string
	/** Shown as a header button when the browser can open a floating window. */
	onPopOut?: () => void
}) {
	const views = useSessionViews(extract, skillLinks)
	const [tab, setTab] = React.useState<SessionTab>('live')
	// A lesson change can take away the open tab's moments.
	const shown = views.tabs.includes(tab) ? tab : 'live'

	return (
		<section
			aria-label="Agent session"
			className={cn(
				'bg-background text-foreground flex h-full flex-col',
				className,
			)}
		>
			<header className="flex items-center gap-2 border-b px-3 py-2.5">
				<Terminal className="text-muted-foreground size-4" aria-hidden />
				<h2 className={TYPE.cardTitle}>Session on screen</h2>
				{onPopOut && (
					<button
						type="button"
						onClick={onPopOut}
						className={cn(
							TYPE.metaSm,
							'text-muted-foreground hover:text-foreground ml-auto flex items-center gap-1 rounded-[4px] px-1 py-0.5',
						)}
					>
						<PictureInPicture2 className="size-3.5" aria-hidden />
						Pop out
					</button>
				)}
			</header>
			{views.tabs.length > 1 ? (
				<Tabs
					value={shown}
					onValueChange={(value) => setTab(value as SessionTab)}
					className="min-h-0 flex-1 gap-0"
				>
					<SessionViewTabs tabs={views.tabs} />
					{/* Kept mounted, so a reader who scrolled Live and looked at another
					    tab comes back to the same spot. */}
					<TabsContent
						value="live"
						forceMount
						className="relative flex min-h-0 flex-col data-[state=inactive]:hidden"
					>
						<LiveSession
							extract={extract}
							skillLinks={skillLinks}
							shown={shown === 'live'}
						/>
					</TabsContent>
					{views.tabs
						.filter((view) => view !== 'live')
						.map((view) => (
							<TabsContent
								key={view}
								value={view}
								className="flex min-h-0 flex-col"
							>
								<SessionMomentList
									moments={views.byTab[view as Exclude<SessionTab, 'live'>]}
								/>
							</TabsContent>
						))}
				</Tabs>
			) : (
				<LiveSession extract={extract} skillLinks={skillLinks} />
			)}
		</section>
	)
}

/**
 * The whole session, followed in step with the lesson player: the view keeps
 * the newest entry the video has reached in sight, and a click on a message
 * or a time seeks the video. The reply block Matt is reading out is marked,
 * matched from the captions.
 */
function LiveSession({
	extract,
	skillLinks,
	shown = true,
}: {
	extract: SessionExtract
	skillLinks?: Readonly<Record<string, string>>
	/** False while another tab is open; Live stays mounted under it. */
	shown?: boolean
}) {
	const rows = React.useMemo(() => sessionExtractRows(extract), [extract])
	const { muxPlayerRef } = useMuxPlayer()
	const time = usePlayerTime(muxPlayerRef)
	// The whole session is on the page from the start, so a reader can find a
	// moment and jump to it; `active` is the newest row the video has reached.
	const active = activeRowIndex(rows, time)
	const contentRef = React.useRef<HTMLDivElement>(null)
	const anchorRef = React.useRef<HTMLElement | null>(null)
	const spoken = useSpokenBlock(
		contentRef,
		anchorRef,
		muxPlayerRef,
		time,
		active,
	)
	const bar = useBlockBar(contentRef, spoken)
	const scrollRef = React.useRef<HTMLDivElement>(null)
	// Following is the view tracking the video. Any scroll by hand, either
	// way, stops it; the Follow video button, a seek from the panel, or a
	// seek back in the player turns it on again.
	const [following, setFollowing] = React.useState(true)
	const [videoIs, setVideoIs] = React.useState<'above' | 'below'>('below')

	// Where following holds the view. Reading only moves forward: the last
	// block Matt read out stays the anchor after its highlight fades, held
	// near the top, and the newest entry the video has reached is kept in
	// the upper part of the panel.
	const followTop = React.useCallback((scroller: HTMLElement) => {
		const content = contentRef.current
		if (!content) return 0
		const origin = content.getBoundingClientRect().top
		const topOf = (element: Element) =>
			element.getBoundingClientRect().top - origin
		const anchor = anchorRef.current?.isConnected ? anchorRef.current : null
		const newest = content.querySelector('[data-current]')
		let target = anchor ? topOf(anchor) - ANCHOR_OFFSET : 0
		if (newest) {
			target = Math.max(
				target,
				topOf(newest) - scroller.clientHeight * REVEAL_AT,
			)
		}
		return Math.min(
			scroller.scrollHeight - scroller.clientHeight,
			Math.max(0, target),
		)
	}, [])
	const follow = React.useCallback(
		(behavior: ScrollBehavior) => {
			const scroller = scrollRef.current
			if (!scroller) return
			const top = followTop(scroller)
			if (Math.abs(scroller.scrollTop - top) > 1) {
				scroller.scrollTo({ top, behavior })
			}
		},
		[followTop],
	)

	React.useEffect(() => {
		if (spoken) anchorRef.current = spoken
		if (following) follow('smooth')
	}, [spoken, active, following, follow])

	// Hidden, the view kept its place but could not follow; back on screen,
	// a following view catches up with the video at once.
	const wasShown = React.useRef(shown)
	React.useEffect(() => {
		const back = shown && !wasShown.current
		wasShown.current = shown
		if (!back || !following) return
		const frame = requestAnimationFrame(() => follow('instant'))
		return () => cancelAnimationFrame(frame)
	}, [shown, following, follow])

	// Seeking back drops the anchor and places the view where reading from
	// that moment would have it, following again.
	const previousTime = React.useRef(time)
	React.useEffect(() => {
		const back = time < previousTime.current - 1
		previousTime.current = time
		if (!back) return
		anchorRef.current = null
		setFollowing(true)
		const frame = requestAnimationFrame(() => follow('instant'))
		return () => cancelAnimationFrame(frame)
	}, [time, follow])

	const stopFollowing = () => setFollowing(false)
	const seek = (seconds: number) => {
		seekPlayer(muxPlayerRef, seconds)
		// What was clicked is where the video is now.
		setFollowing(true)
	}
	// The moment the pointer is over, by the index of the row that heads it.
	// Rows that show the same time (10.1s and 10.8s both read 0:10) share
	// one, which seeks to the first of them.
	const [hovered, setHovered] = React.useState<number | null>(null)
	const heads = rows.map((row, index) => index)
	rows.forEach((row, index) => {
		const previous = rows[index - 1]
		if (
			previous &&
			formatTime(previous.visibleFrom) === formatTime(row.visibleFrom)
		) {
			heads[index] = heads[index - 1]!
		}
	})

	return (
		<div className="relative min-h-0 flex-1">
			<div
				ref={scrollRef}
				// Input that scrolls the panel is the reader taking over; scrolls
				// made by following itself come with none of it.
				onWheel={stopFollowing}
				onTouchMove={stopFollowing}
				onPointerDown={(event) => {
					// Grabbing the scrollbar lands on the scroller itself.
					if (event.target === event.currentTarget) stopFollowing()
				}}
				onKeyDown={(event) => {
					if (
						[
							'ArrowUp',
							'ArrowDown',
							'PageUp',
							'PageDown',
							'Home',
							'End',
							' ',
						].includes(event.key)
					) {
						stopFollowing()
					}
				}}
				onScroll={(event) => {
					if (following) return
					const scroller = event.currentTarget
					setVideoIs(
						followTop(scroller) < scroller.scrollTop ? 'above' : 'below',
					)
				}}
				className="h-full [scrollbar-gutter:stable] overflow-y-auto"
			>
				<div
					ref={contentRef}
					className="relative flex flex-col px-3 pb-3"
					onPointerLeave={() => setHovered(null)}
				>
					{/* Before the rows, which stay the content's only siblings after it. */}
					{bar && (
						<span
							aria-hidden
							data-spoken-bar=""
							className="bg-primary pointer-events-none absolute left-1 w-0.5 rounded-full transition-[top,height] duration-300 motion-reduce:transition-none"
							style={bar}
						/>
					)}
					{rows.map((row, index) => {
						const previous = rows[index - 1]
						const timed = heads[index] === index
						const message = isMessage(row)
						return (
							// The time heads its moment on a line of its own, at the
							// left edge, the same as in the other tabs. What the
							// video has not reached yet sits back.
							<div
								key={index}
								data-reached={index <= active ? '' : undefined}
								data-current={index === active ? '' : undefined}
								onPointerEnter={() => setHovered(heads[index]!)}
								onClick={
									message
										? (event) => {
												// A message plays from its moment; a link, a
												// button, or text being selected keeps its own job.
												if (
													(event.target as Element).closest('a, button') ||
													window.getSelection()?.toString()
												) {
													return
												}
												seek(row.visibleFrom)
											}
										: undefined
								}
								className={cn(
									'flex flex-col gap-1.5 transition-opacity duration-300 motion-reduce:transition-none',
									index > active && 'opacity-50',
									message && 'cursor-pointer',
									timed
										? 'mt-5 first:mt-4'
										: isCall(row) && previous && isCall(previous)
											? 'mt-0.5'
											: 'mt-3',
								)}
							>
								{timed && (
									<TimeButton
										seconds={row.visibleFrom}
										seek={seek}
										active={hovered === index}
										className="self-start"
									/>
								)}
								<RowBody row={row} skillLinks={skillLinks} />
							</div>
						)
					})}
				</div>
			</div>
			{!following && (
				<FollowVideoButton
					videoIs={videoIs}
					onFollow={() => setFollowing(true)}
				/>
			)}
		</div>
	)
}

/**
 * The session on a phone: the newest entry, cut short, as one button that
 * opens the full panel. Below the player the page has to keep scrolling, and
 * a tall scroller of its own there would trap the reader's thumb.
 */
export function SessionExtractStrip({
	extract,
	onOpen,
}: {
	extract: SessionExtract
	onOpen: () => void
}) {
	const rows = React.useMemo(() => sessionExtractRows(extract), [extract])
	const { muxPlayerRef } = useMuxPlayer()
	const newest = rowsOnScreen(rows, usePlayerTime(muxPlayerRef)).at(-1)

	// The preview holds buttons of its own, so the strip is a div and its one
	// button stretches over all of it.
	return (
		<div className="bg-background text-foreground relative flex flex-col gap-1.5 px-3 py-2.5">
			<div className="flex items-center gap-2">
				<Terminal className="text-muted-foreground size-4" aria-hidden />
				<h2 className={TYPE.cardTitle}>Session on screen</h2>
				<button
					type="button"
					onClick={onOpen}
					className={cn(
						TYPE.metaSm,
						'text-muted-foreground ml-auto after:absolute after:inset-0',
					)}
				>
					Open
				</button>
			</div>
			{/* A fixed height, so the page never shifts as entries change. */}
			<div className="h-16 overflow-hidden">
				{newest ? (
					// A preview only: inert, and faded out where it is cut.
					<div
						inert
						className="h-full [mask-image:linear-gradient(to_bottom,black_60%,transparent)]"
					>
						<RowBody row={newest} />
					</div>
				) : (
					<p className={cn(TYPE.metaSm, 'text-muted-foreground')}>
						The session appears here as the video reaches it.
					</p>
				)}
			</div>
		</div>
	)
}

/** A user or assistant message: what a click on the transcript plays from. */
function isMessage(row: SessionExtractRow) {
	return (
		row.type === 'entry' &&
		(row.entry.kind === 'userPrompt' || row.entry.kind === 'assistantText')
	)
}

function isCall(row: SessionExtractRow) {
	return (
		row.type === 'tools' ||
		(row.type === 'entry' && row.entry.kind === 'skillCall')
	)
}

function RowBody({
	row,
	skillLinks,
}: {
	row: SessionExtractRow
	skillLinks?: Readonly<Record<string, string>>
}) {
	if (row.type === 'sessionStart') {
		return (
			<p className={cn(TYPE.metaSm, 'text-muted-foreground')}>
				New session after <code className="text-[0.86em]">/clear</code>
			</p>
		)
	}
	if (row.type === 'tools') {
		const only = row.entries.length === 1 ? row.entries[0]! : null
		return (
			<CallRow
				icon={<WrenchIcon className="size-3" />}
				title={
					only ? (
						<>
							<span className="text-foreground/80">{only.tool}</span>
							{only.summary && <> · {only.summary}</>}
						</>
					) : (
						<>
							<span className="text-foreground/80">
								{row.entries.length} tool calls
							</span>
							<span>
								{' '}
								·{' '}
								{[...new Set(row.entries.map((entry) => entry.tool))].join(
									', ',
								)}
							</span>
						</>
					)
				}
				failed={row.entries.some((entry) => entry.resultIsError)}
			>
				{!only && (
					<ul className={cn(TYPE.metaMono, 'space-y-1 text-[0.86em]')}>
						{row.entries.map((entry, index) => (
							<li key={index} className="text-muted-foreground break-words">
								<span className="text-foreground">{entry.tool}</span>
								{entry.summary && ` · ${entry.summary}`}
								{entry.resultIsError && (
									<span className="text-destructive"> · failed</span>
								)}
							</li>
						))}
					</ul>
				)}
			</CallRow>
		)
	}

	const { entry } = row
	switch (entry.kind) {
		case 'userPrompt':
			return (
				<Message from="user" className="max-w-[92%]">
					<MessageContent
						className={cn(
							SESSION_PROSE,
							'break-words whitespace-pre-wrap group-[.is-user]:px-3 group-[.is-user]:py-2',
						)}
					>
						{entry.text}
					</MessageContent>
				</Message>
			)
		case 'assistantText':
			return (
				<Message from="assistant" data-reply className="max-w-full">
					<MessageContent className="w-full">
						<MessageResponse className={REPLY_TYPE}>
							{entry.text}
						</MessageResponse>
					</MessageContent>
				</Message>
			)
		case 'skillCall': {
			const skillUrl = skillLinks?.[skillKey(entry.skill)]
			return (
				<CallRow
					icon={<SparklesIcon className="size-3" />}
					title={
						<>
							Skill <span className="text-primary">{entry.skill}</span>
						</>
					}
					failed={entry.via === 'toolCall' && entry.resultIsError === true}
					aside={skillUrl && <SkillPageLink href={skillUrl} />}
				>
					{entry.skillBody && (
						<MessageResponse className={DETAIL_TYPE}>
							{entry.skillBody}
						</MessageResponse>
					)}
				</CallRow>
			)
		}
		case 'interrupt':
			return (
				<p className={cn(TYPE.metaSm, 'text-muted-foreground italic')}>
					{entry.text}
				</p>
			)
	}
}

/**
 * A tool or skill call: one quiet line that opens to its detail. Stubs carry
 * no run state, so the line shows none, only a failure when there was one.
 */
function CallRow({
	icon,
	title,
	failed,
	aside,
	children,
}: {
	icon: React.ReactNode
	title: React.ReactNode
	failed: boolean
	/** At the line's end, beside (never inside) the toggle. */
	aside?: React.ReactNode
	children?: React.ReactNode
}) {
	const header = (
		<>
			<span className="shrink-0">{icon}</span>
			<span className="min-w-0 truncate">{title}</span>
			{failed && (
				<XCircleIcon
					className="text-destructive size-3 shrink-0"
					aria-label="Failed"
				/>
			)}
		</>
	)
	const line = cn(
		TYPE.metaSm,
		'text-muted-foreground flex h-5 w-full items-center gap-1.5 text-left',
	)

	if (!children) {
		return (
			<div className={line}>
				{header}
				{aside && <span className="ml-auto pl-2">{aside}</span>}
			</div>
		)
	}
	return (
		<Tool className="mb-0 rounded-none border-0">
			<div className="flex items-center gap-2">
				<CollapsibleTrigger
					className={cn(line, 'hover:text-foreground min-w-0 flex-1')}
				>
					{header}
					<ChevronDownIcon className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
				</CollapsibleTrigger>
				{aside}
			</div>
			<ToolContent className="my-1 ml-1.5 border-l pl-3">
				{children}
			</ToolContent>
		</Tool>
	)
}

/**
 * Marks the reply block (paragraph, list item, heading, table row) that the
 * last few seconds of captions match, with `data-spoken`. Captions come from
 * the player's own caption track, kept loaded in `hidden` mode
 * (`useHiddenCaptions`).
 */
function useSpokenBlock(
	contentRef: React.RefObject<HTMLDivElement | null>,
	/** The last block read out; only it and what follows can match. */
	anchorRef: React.RefObject<HTMLElement | null>,
	playerRef: PlayerRef,
	time: number,
	active: number,
) {
	const [spoken, setSpoken] = React.useState<HTMLElement | null>(null)
	const lastMatch = React.useRef({ active, time })
	useHiddenCaptions(playerRef)

	React.useEffect(() => {
		const content = contentRef.current
		const track = captionTrack(playerRef?.current)
		if (!content || !track) return

		const words = contentWords(
			Array.from(track.cues ?? [])
				.filter(
					(cue) => cue.endTime > time - SPOKEN_WINDOW && cue.startTime <= time,
				)
				.map((cue) => (cue as VTTCue).text)
				.join(' '),
		)
		const blocks = Array.from(
			content.querySelectorAll('[data-reached] [data-reply]'),
		)
			.slice(-SPOKEN_REPLIES)
			.flatMap((reply) =>
				Array.from(reply.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)),
			)
			// A list item that wraps paragraphs is matched through them.
			.filter((block) => !block.querySelector(BLOCK_SELECTOR))
			// Reading runs one way: nothing above where Matt already is.
			.filter((block) => {
				const anchor = anchorRef.current
				return (
					!anchor?.isConnected ||
					anchor === block ||
					Boolean(
						anchor.compareDocumentPosition(block) &
						Node.DOCUMENT_POSITION_FOLLOWING,
					)
				)
			})
		const match =
			blocks[
				spokenBlockIndex(
					words,
					blocks.map((block) => contentWords(block.textContent ?? '')),
				)
			]

		// A pause to riff keeps the last match for a few seconds; the next
		// entry, a seek back, or a long demo away from the session clears it.
		setSpoken((current) => {
			if (match) {
				lastMatch.current = { active, time }
				return match
			}
			const held =
				current?.isConnected &&
				lastMatch.current.active === active &&
				time >= lastMatch.current.time &&
				time - lastMatch.current.time < SPOKEN_HOLD
			return held ? current : null
		})
	}, [contentRef, anchorRef, playerRef, time, active])

	React.useEffect(() => {
		if (!spoken) return
		spoken.setAttribute('data-spoken', '')
		return () => spoken.removeAttribute('data-spoken')
	}, [spoken])

	return spoken
}

/**
 * Where the spoken block sits in the panel, for the bar in the left gutter
 * that marks it, as the Skills tab marks its current moment. The text keeps
 * one color throughout: at 2x a color change on every block read as flicker.
 * The bar overlays the gutter, so moving it never reflows the reply.
 */
function useBlockBar(
	contentRef: React.RefObject<HTMLDivElement | null>,
	block: HTMLElement | null,
) {
	const [bar, setBar] = React.useState<{ top: number; height: number } | null>(
		null,
	)
	React.useLayoutEffect(() => {
		const content = contentRef.current
		if (!content || !block) {
			setBar(null)
			return
		}
		const measure = () => {
			const rect = block.getBoundingClientRect()
			const top = rect.top - content.getBoundingClientRect().top
			const height = rect.height
			setBar((current) =>
				current?.top === top && current.height === height
					? current
					: { top, height },
			)
		}
		measure()
		// A wider or narrower panel rewraps the reply above and in the block.
		const observer = new ResizeObserver(measure)
		observer.observe(content)
		return () => observer.disconnect()
	}, [contentRef, block])
	return bar
}

/**
 * Keeps the caption track's cues loading while captions are off
 * (`keepCaptionCuesLoading`): the player adds its tracks after the manifest
 * loads and turns them off with captions (`addtrack`, `change`), and a new
 * lesson brings a new source (`loadedmetadata`).
 */
function useHiddenCaptions(playerRef: PlayerRef) {
	React.useEffect(() => {
		const player = playerRef?.current
		const tracks = player?.media?.nativeEl?.textTracks ?? player?.textTracks
		if (!tracks) return

		const keepLoaded = () => keepCaptionCuesLoading(player)
		keepLoaded()
		tracks.addEventListener('addtrack', keepLoaded)
		tracks.addEventListener('change', keepLoaded)
		player?.addEventListener('loadedmetadata', keepLoaded)
		return () => {
			tracks.removeEventListener('addtrack', keepLoaded)
			tracks.removeEventListener('change', keepLoaded)
			player?.removeEventListener('loadedmetadata', keepLoaded)
		}
	}, [playerRef])
}

function captionTrack(player: MuxPlayerRefAttributes | null | undefined) {
	const tracks = player?.media?.nativeEl?.textTracks ?? player?.textTracks
	return Array.from(tracks ?? []).find(
		(track) => track.kind === 'subtitles' || track.kind === 'captions',
	)
}

/**
 * Shown while the reader has scrolled away from the video's place, either
 * way; it turns following back on. The arrow points to where the video is.
 */
function FollowVideoButton({
	videoIs,
	onFollow,
}: {
	videoIs: 'above' | 'below'
	onFollow: () => void
}) {
	const Arrow = videoIs === 'above' ? ArrowUpIcon : ArrowDownIcon
	return (
		<Button
			type="button"
			variant="outline"
			size="sm"
			onClick={onFollow}
			className={cn(
				TYPE.metaSm,
				'dark:bg-background absolute bottom-3 left-1/2 h-7 -translate-x-1/2 gap-1.5 rounded-full px-3',
			)}
		>
			<Arrow className="size-3.5" aria-hidden />
			Follow video
		</Button>
	)
}
