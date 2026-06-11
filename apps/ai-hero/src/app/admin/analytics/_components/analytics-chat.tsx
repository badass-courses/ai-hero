'use client'

import { useState } from 'react'
import {
	Conversation,
	ConversationContent,
	ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import {
	Message,
	MessageContent,
	MessageResponse,
} from '@/components/ai-elements/message'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'

import { cn } from '@coursebuilder/ui/utils/cn'

const SUGGESTED_PROMPTS = [
	'What was our best revenue day this month?',
	'Which YouTube video drove the most subscribers?',
	'What % of revenue is attributed vs dark?',
	'Compare this week to last week',
	'What content do buyers watch before purchasing?',
	'Where does our YouTube traffic come from?',
]

function ToolResultPreview({ args, result }: { args: any; result: any }) {
	if (!result) return null

	if (result.totalRevenue !== undefined) {
		return (
			<div className="grid grid-cols-3 gap-3 py-2 text-sm">
				<div>
					<span className="text-muted-foreground block text-xs">Revenue</span>
					<span className="text-foreground font-semibold tabular-nums">
						${Number(result.totalRevenue).toLocaleString()}
					</span>
				</div>
				<div>
					<span className="text-muted-foreground block text-xs">Purchases</span>
					<span className="text-foreground font-semibold tabular-nums">
						{result.purchaseCount?.toLocaleString() ?? '—'}
					</span>
				</div>
				<div>
					<span className="text-muted-foreground block text-xs">AOV</span>
					<span className="text-foreground font-semibold tabular-nums">
						${Number(result.avgOrderValue ?? 0).toFixed(0)}
					</span>
				</div>
			</div>
		)
	}

	if (result.subscriberCount !== undefined) {
		return (
			<div className="grid grid-cols-3 gap-3 py-2 text-sm">
				<div>
					<span className="text-muted-foreground block text-xs">Subs</span>
					<span className="text-foreground font-semibold tabular-nums">
						{Number(result.subscriberCount).toLocaleString()}
					</span>
				</div>
				<div>
					<span className="text-muted-foreground block text-xs">Views</span>
					<span className="text-foreground font-semibold tabular-nums">
						{Number(result.viewCount).toLocaleString()}
					</span>
				</div>
				<div>
					<span className="text-muted-foreground block text-xs">Videos</span>
					<span className="text-foreground font-semibold tabular-nums">
						{result.videoCount}
					</span>
				</div>
			</div>
		)
	}

	if (Array.isArray(result)) {
		return (
			<span className="text-muted-foreground py-1 text-xs">
				{result.length} results
			</span>
		)
	}

	if (result.conversionRate !== undefined) {
		return (
			<div className="grid grid-cols-2 gap-3 py-2 text-sm">
				<div>
					<span className="text-muted-foreground block text-xs">
						Conversion
					</span>
					<span className="text-foreground font-semibold tabular-nums">
						{(result.conversionRate * 100).toFixed(1)}%
					</span>
				</div>
				<div>
					<span className="text-muted-foreground block text-xs">
						Attribution
					</span>
					<span className="text-foreground font-semibold tabular-nums">
						{(result.attributionCoverage * 100).toFixed(1)}%
					</span>
				</div>
			</div>
		)
	}

	return (
		<pre className="text-muted-foreground max-h-32 overflow-auto text-xs">
			{JSON.stringify({ args, result }, null, 2)}
		</pre>
	)
}

function getToolLabel(part: { type: string; input?: any }) {
	if (part.type === 'tool-queryAnalytics') {
		return `📡 ${part.input?.surface}${part.input?.range ? ` · ${part.input.range}` : ''}`
	}

	if (part.type === 'tool-compareRanges') {
		return `📊 ${part.input?.surface} (${part.input?.currentRange} vs ${part.input?.previousRange})`
	}

	if (part.type === 'tool-computeMetric') {
		return `🧮 ${part.input?.metric}`
	}

	return `🛠 ${part.type.replace(/^tool-/, '')}`
}

export function AnalyticsChat({ className }: { className?: string }) {
	const [input, setInput] = useState('')
	const { messages, sendMessage, status } = useChat({
		transport: new DefaultChatTransport({ api: '/api/analytics/chat' }),
	})

	const isEmpty = messages.length === 0

	return (
		<div
			className={cn(
				'bg-card/50 flex flex-col overflow-hidden rounded-xl border',
				className,
			)}
		>
			<div className="border-b px-5 py-3">
				<div className="flex items-center gap-2">
					<div className="bg-primary/20 flex h-6 w-6 items-center justify-center rounded-md text-xs">
						📊
					</div>
					<span className="text-sm font-medium">Analytics Agent</span>
					{status === 'streaming' && (
						<span className="text-muted-foreground animate-pulse text-xs">
							thinking…
						</span>
					)}
				</div>
			</div>

			<div className="min-h-0 flex-1">
				<Conversation>
					<ConversationContent>
						{isEmpty && (
							<div className="flex flex-col items-center justify-center gap-4 px-5 py-10">
								<p className="text-muted-foreground text-sm">
									Ask anything about revenue, YouTube, attribution, or traffic
								</p>
								<div className="flex flex-wrap justify-center gap-2">
									{SUGGESTED_PROMPTS.map((prompt) => (
										<button
											key={prompt}
											onClick={() => {
												setInput(prompt)
											}}
											className="bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground rounded-full px-3 py-1.5 text-xs transition-colors"
										>
											{prompt}
										</button>
									))}
								</div>
							</div>
						)}

						{messages.map((message) => (
							<Message key={message.id} from={message.role}>
								<MessageContent>
									{message.parts?.map((part, i) => {
										switch (part.type) {
											case 'text':
												return (
													<MessageResponse key={i}>{part.text}</MessageResponse>
												)
											default:
												if (
													part.type === 'dynamic-tool' ||
													part.type.startsWith('tool-')
												) {
													const toolPart = part as Extract<
														typeof part,
														| { type: 'dynamic-tool' }
														| { type: `tool-${string}` }
													>

													return (
														<div
															key={i}
															className="bg-muted/30 border-border/50 my-1 overflow-hidden rounded-lg border"
														>
															<div className="text-muted-foreground flex items-center gap-2 px-3 py-2 text-xs font-medium">
																<span>{getToolLabel(toolPart)}</span>
															</div>
															<div className="border-border/50 border-t px-3 py-2">
																{toolPart.state === 'output-available' && (
																	<ToolResultPreview
																		args={toolPart.input}
																		result={toolPart.output}
																	/>
																)}
																{(toolPart.state === 'input-available' ||
																	toolPart.state === 'input-streaming') && (
																	<span className="text-muted-foreground animate-pulse text-xs">
																		Querying…
																	</span>
																)}
																{toolPart.state === 'output-error' && (
																	<span className="text-destructive text-xs">
																		{toolPart.errorText}
																	</span>
																)}
															</div>
														</div>
													)
												}
												return null
										}
									})}
								</MessageContent>
							</Message>
						))}
					</ConversationContent>
					<ConversationScrollButton />
				</Conversation>
			</div>

			<div className="border-t p-3">
				<form
					onSubmit={(event) => {
						event.preventDefault()
						const value = input.trim()
						if (!value || status !== 'ready') return
						sendMessage({ text: value })
						setInput('')
					}}
					className="flex items-end gap-2"
				>
					<textarea
						value={input}
						onChange={(event) => {
							setInput(event.target.value)
						}}
						onKeyDown={(event) => {
							if (event.key === 'Enter' && !event.shiftKey) {
								event.preventDefault()
								const value = input.trim()
								if (!value || status !== 'ready') return
								sendMessage({ text: value })
								setInput('')
							}
						}}
						placeholder="Ask about your metrics…"
						rows={1}
						className="bg-muted/50 border-border placeholder:text-muted-foreground focus:ring-primary/20 min-h-[40px] flex-1 resize-none rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2"
					/>
					<button
						type="submit"
						disabled={status !== 'ready' || !input.trim()}
						className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed"
					>
						Send
					</button>
				</form>
			</div>
		</div>
	)
}
