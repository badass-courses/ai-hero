import * as React from 'react'
import { reprocessTranscript } from '@/app/(content)/posts/[slug]/edit/actions'
import Spinner from '@/components/spinner'
import { getVideoResource } from '@/lib/video-resource-query'
import { RefreshCcw } from 'lucide-react'
import ReactMarkdown from 'react-markdown'

import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from '@coursebuilder/ui'

type TranscriptDialogProps = {
	transcript?: string | null
	isProcessing: boolean
	onReprocess: () => Promise<void>
	isOpen: boolean
	onOpenChange: (open: boolean) => void
	/**
	 * Render the inline "View Transcript" trigger button (legacy surfaces).
	 * false → the dialog is opened imperatively via `openTranscriptDialog`
	 * (the cms Video tab's kit slot owns its own affordance).
	 */
	showTrigger?: boolean
}

const TranscriptDialog: React.FC<TranscriptDialogProps> = ({
	transcript,
	isProcessing,
	onReprocess,
	isOpen,
	onOpenChange,
	showTrigger = true,
}) => {
	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			{showTrigger ? (
				<DialogTrigger asChild>
					<Button variant="outline" size={'sm'} type="button">
						View Transcript
					</Button>
				</DialogTrigger>
			) : null}
			<DialogContent className="sm:max-h-[80vh]">
				<DialogHeader className="flex items-baseline justify-between">
					<DialogTitle>Transcript</DialogTitle>
				</DialogHeader>
				<div className="max-h-[60vh] overflow-auto">
					{isProcessing ? (
						<div className="flex flex-col items-center justify-center gap-2 py-8">
							<Spinner className="h-4 w-4" />
							<span className="text-sm">Processing transcript...</span>
						</div>
					) : (
						<ReactMarkdown className="prose prose-sm dark:prose-invert relative mt-3 max-w-none overflow-hidden pr-3">
							{transcript}
						</ReactMarkdown>
					)}
				</div>
				<DialogFooter className="flex items-center">
					<Button
						variant="secondary"
						type="button"
						className="gap-2 [&_svg]:opacity-40"
						onClick={onReprocess}
						title="Reprocess"
					>
						<RefreshCcw className="w-3" /> Reprocess Transcript
					</Button>
					<Button type="button" onClick={() => onOpenChange(false)}>
						Close
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

export function useTranscript(options: {
	videoResourceId: string | null | undefined
	initialTranscript?: string | null
	/**
	 * false → the returned TranscriptDialog renders WITHOUT its inline
	 * trigger button; open it via the returned `openTranscriptDialog`
	 * (cms Video tab wiring). Defaults to true (legacy surfaces).
	 */
	withDialogTrigger?: boolean
}) {
	const [transcript, setTranscript] = React.useState<string | null>(
		options.initialTranscript || null,
	)
	const [isProcessing, setIsProcessing] = React.useState(false)
	const [isOpen, setIsOpen] = React.useState(false)

	// Re-seed transcript state whenever the video (or its transcript) changes.
	// Important: clear to null when the new video has no transcript, so a
	// swapped-in video doesn't keep showing the previous video's transcript.
	React.useEffect(() => {
		setTranscript(options.initialTranscript ?? null)
		setIsProcessing(false)
	}, [options.videoResourceId, options.initialTranscript])

	React.useEffect(() => {
		let isSubscribed = true

		async function run() {
			try {
				if (options.videoResourceId) {
					const { value: transcript } = await pollVideoResourceTranscript(
						options.videoResourceId,
					).next()
					if (transcript && isSubscribed) {
						setTranscript(transcript)
					}
				}
			} catch (error) {
				console.error('Error polling video resource transcript:', error)
			}
		}

		if (!options.initialTranscript && transcript === null) {
			run()
		}

		return () => {
			isSubscribed = false
		}
	}, [options.initialTranscript, options.videoResourceId, transcript])

	const handleReprocess = async () => {
		if (!options.videoResourceId) return

		setIsProcessing(true)
		setTranscript(null)
		await reprocessTranscript({
			videoResourceId: options.videoResourceId,
		})
	}

	const TranscriptDialogComponent = transcript ? (
		<TranscriptDialog
			transcript={transcript}
			isProcessing={isProcessing}
			onReprocess={handleReprocess}
			isOpen={isOpen}
			onOpenChange={setIsOpen}
			showTrigger={options.withDialogTrigger !== false}
		/>
	) : null

	const openTranscriptDialog = React.useCallback(() => setIsOpen(true), [])

	return {
		transcript,
		setTranscript,
		isProcessing,
		setIsProcessing,
		TranscriptDialog: TranscriptDialogComponent,
		/** Imperative opener — pairs with `withDialogTrigger: false`. */
		openTranscriptDialog,
	} as const
}

async function* pollVideoResourceTranscript(
	videoResourceId: string,
	maxAttempts = 30,
	initialDelay = 250,
	delayIncrement = 1000,
) {
	let delay = initialDelay

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const videoResource = await getVideoResource(videoResourceId)
		if (videoResource?.transcript) {
			yield videoResource.transcript
			return
		}

		await new Promise((resolve) => setTimeout(resolve, delay))
		delay += delayIncrement
	}

	throw new Error('Video resource not found after maximum attempts')
}
