'use client'

import * as React from 'react'
import {
	Conversation,
	ConversationContent,
} from '@/components/ai-elements/conversation'
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
	rowsOnScreen,
	sessionExtractRows,
	spokenBlockIndex,
	type SessionExtract,
	type SessionExtractRow,
} from '@/lib/session-extract'
import type { MuxPlayerRefAttributes } from '@mux/mux-player-react'
import {
	useStickToBottomContext,
	type GetTargetScrollTop,
	type StickToBottomContext,
} from 'use-stick-to-bottom'
import {
	ArrowDownIcon,
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
	SessionMomentList,
	SessionViewTabs,
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
 * Markdown inside the panel: mono runs a size down (a mono face reads larger
 * than the sans beside it) on a translucent chip, so the spoken highlight
 * shows through code instead of stopping at it.
 */
const REPLY_TYPE = cn(
	TYPE.metaProse,
	'[&_:not(pre)>code]:bg-foreground/[0.07] [&_:not(pre)>code]:rounded-[4px] [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-px [&_:not(pre)>code]:text-[0.86em] [&_:not(pre)>code]:font-normal',
	'[&_hr]:my-3 [&_li]:my-0.5 [&_ol]:my-1.5 [&_p]:my-1.5 [&_ul]:my-1.5',
)

/**
 * Expanded call detail (a skill's injected text): reference, not the
 * conversation, so a step smaller and dimmer, wrapped in full with no scroll
 * box of its own.
 */
const DETAIL_TYPE = cn(
	REPLY_TYPE,
	TYPE.metaSm,
	'text-muted-foreground [overflow-wrap:anywhere] [&_strong]:text-foreground/80 [&_:is(h1,h2,h3,h4)]:text-[1em]',
)

/**
 * The spoken block: a faint gold wash bleeding a few pixels past the text,
 * while the rest of its reply steps back, so focus reads as contrast rather
 * than a fill. Both fade as Matt moves through the reply.
 */
const SPOKEN_HIGHLIGHT = cn(
	'[&_:is(p,li,h1,h2,h3,h4,h5,h6,tr)]:transition-colors [&_:is(p,li,h1,h2,h3,h4,h5,h6,tr)]:duration-500',
	'[&_[data-reply]:has([data-spoken])_:is(p,li,h1,h2,h3,h4,h5,h6,tr)]:text-foreground/55',
	// A band across the panel's full width, however deep the block is nested:
	// the border image paints outside the block (6px above and below, the
	// viewport's width sideways) and the scroller clips it at its edges.
	'[&_[data-spoken]]:!text-foreground [&_[data-spoken]]:[border-image:linear-gradient(color-mix(in_oklab,var(--foreground)_6%,transparent)_0_0)_fill_0//6px_100vw]',
	'motion-reduce:[&_:is(p,li,h1,h2,h3,h4,h5,h6,tr)]:transition-none',
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
	/** Skill pages by `skillKey`, for the Skills tab. */
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
					<TabsContent value="live" className="relative flex min-h-0 flex-col">
						<LiveSession extract={extract} />
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
				<LiveSession extract={extract} />
			)}
		</section>
	)
}

/**
 * The session revealed in step with the lesson player: an entry appears when
 * it appears in the video, the list sticks to the newest one, and every
 * entry's time seeks the video. The reply block Matt is reading out is
 * highlighted, matched from the captions.
 */
function LiveSession({ extract }: { extract: SessionExtract }) {
	const rows = React.useMemo(() => sessionExtractRows(extract), [extract])
	const { muxPlayerRef } = useMuxPlayer()
	const time = usePlayerTime(muxPlayerRef)
	const visible = rowsOnScreen(rows, time)
	const active = visible.length - 1
	const contentRef = React.useRef<HTMLDivElement>(null)
	const anchorRef = React.useRef<HTMLElement | null>(null)
	const spoken = useSpokenBlock(
		contentRef,
		anchorRef,
		muxPlayerRef,
		time,
		active,
	)
	const stickRef = React.useRef<StickToBottomContext>(null)

	// Reading only moves forward. The last block Matt read out stays the
	// anchor after its highlight fades, held near the top; a new entry pushes
	// the view on only as far as revealing it needs. The library animates
	// down toward this target and never up, and scrolling up escapes it.
	const targetScrollTop = React.useCallback<GetTargetScrollTop>(
		(bottom, { scrollElement }) => {
			const content = contentRef.current
			if (!content) return bottom
			const origin = content.getBoundingClientRect().top
			const topOf = (element: Element) =>
				element.getBoundingClientRect().top - origin
			const anchor = anchorRef.current?.isConnected ? anchorRef.current : null
			const newest = content.lastElementChild
			let target = anchor ? topOf(anchor) - ANCHOR_OFFSET : 0
			if (newest) {
				target = Math.max(
					target,
					topOf(newest) - scrollElement.clientHeight * REVEAL_AT,
				)
			}
			return Math.min(bottom, Math.max(0, target))
		},
		[],
	)
	React.useEffect(() => {
		if (spoken) anchorRef.current = spoken
		const stick = stickRef.current
		if (stick?.state.isAtBottom) void stick.scrollToBottom()
	}, [spoken, active])

	// Seeking back is the one way up: drop the anchor and place the view
	// where reading from that moment would have it.
	const previousTime = React.useRef(time)
	React.useEffect(() => {
		const back = time < previousTime.current - 1
		previousTime.current = time
		const stick = stickRef.current
		const scroller = stick?.scrollRef.current
		if (!back || !stick || !scroller) return
		anchorRef.current = null
		const frame = requestAnimationFrame(() => {
			stick.state.scrollTop = targetScrollTop(
				scroller.scrollHeight - scroller.clientHeight,
				{ scrollElement: scroller, contentElement: scroller },
			)
			void stick.scrollToBottom()
		})
		return () => cancelAnimationFrame(frame)
	}, [time, targetScrollTop])

	const seek = (seconds: number) => seekPlayer(muxPlayerRef, seconds)

	return (
		<Conversation
			className="min-h-0 flex-1"
			contextRef={stickRef}
			targetScrollTop={targetScrollTop}
		>
			<ConversationContent className="gap-0 p-0">
				<div
					ref={contentRef}
					className={cn('flex flex-col px-3 pb-3', SPOKEN_HIGHLIGHT)}
				>
					{visible.length === 0 ? (
						<p className={cn(TYPE.metaSm, 'text-muted-foreground pt-4')}>
							The session appears here as the video reaches it.
						</p>
					) : (
						visible.map((row, index) => {
							const previous = visible[index - 1]
							const timed =
								!previous || previous.visibleFrom !== row.visibleFrom
							return (
								// The time sits in the gap above its row, right-aligned,
								// so the content keeps the panel's full width.
								<div
									key={index}
									className={cn(
										'relative',
										timed
											? 'mt-5 first:mt-4'
											: isCall(row) && previous && isCall(previous)
												? 'mt-0.5'
												: 'mt-3',
									)}
								>
									{timed && (
										<button
											type="button"
											onClick={() => seek(row.visibleFrom)}
											aria-label={`Play from ${formatTime(row.visibleFrom)}`}
											className={cn(
												TYPE.navNum,
												'text-muted-foreground hover:text-foreground absolute -top-4 right-0 h-3.5 rounded-[3px] px-0.5',
											)}
										>
											{formatTime(row.visibleFrom)}
										</button>
									)}
									<RowBody row={row} />
								</div>
							)
						})
					)}
				</div>
			</ConversationContent>
			<FollowVideoButton />
		</Conversation>
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

function isCall(row: SessionExtractRow) {
	return (
		row.type === 'tools' ||
		(row.type === 'entry' && row.entry.kind === 'skillCall')
	)
}

function RowBody({ row }: { row: SessionExtractRow }) {
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
							TYPE.metaProse,
							'whitespace-pre-wrap break-words group-[.is-user]:px-3 group-[.is-user]:py-2',
						)}
					>
						{entry.text}
					</MessageContent>
				</Message>
			)
		case 'assistantText':
			return (
				<Message from="assistant" data-reply className="max-w-full">
					{/* Visible overflow lets the spoken band reach the panel edges. */}
					<MessageContent className="w-full overflow-visible">
						<MessageResponse className={REPLY_TYPE}>
							{entry.text}
						</MessageResponse>
					</MessageContent>
				</Message>
			)
		case 'skillCall':
			return (
				<CallRow
					icon={<SparklesIcon className="size-3" />}
					title={
						<>
							Skill <span className="text-primary">{entry.skill}</span>
							{entry.args && <> {entry.args}</>}
						</>
					}
					failed={entry.via === 'toolCall' && entry.resultIsError === true}
				>
					{entry.skillBody && (
						<MessageResponse className={DETAIL_TYPE}>
							{entry.skillBody}
						</MessageResponse>
					)}
				</CallRow>
			)
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
	children,
}: {
	icon: React.ReactNode
	title: React.ReactNode
	failed: boolean
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
		return <div className={line}>{header}</div>
	}
	return (
		<Tool className="mb-0 rounded-none border-0">
			<CollapsibleTrigger className={cn(line, 'hover:text-foreground')}>
				{header}
				<ChevronDownIcon className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
			</CollapsibleTrigger>
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
		const blocks = Array.from(content.querySelectorAll('[data-reply]'))
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
 * Scrolling the panel by hand stops it following the video; this turns
 * following back on, and shows for as long as it is off. Following is the
 * library's `isAtBottom` lock: `escapedFromLock` only clears on a scroll
 * down by hand, so it stays set after the button re-locks.
 */
function FollowVideoButton() {
	const { state, scrollToBottom } = useStickToBottomContext()
	if (state.isAtBottom) return null
	const follow = () => {
		// The library only scrolls down; a reader below the video's place is
		// brought back up first.
		if (state.scrollTop > state.calculatedTargetScrollTop) {
			state.scrollTop = state.calculatedTargetScrollTop
		}
		void scrollToBottom()
	}
	return (
		<Button
			type="button"
			variant="outline"
			size="sm"
			onClick={follow}
			className={cn(
				TYPE.metaSm,
				'dark:bg-background absolute bottom-3 left-1/2 h-7 -translate-x-1/2 gap-1.5 rounded-full px-3',
			)}
		>
			<ArrowDownIcon className="size-3.5" aria-hidden />
			Follow video
		</Button>
	)
}
