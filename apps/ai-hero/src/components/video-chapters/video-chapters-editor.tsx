'use client'

import * as React from 'react'
import { api } from '@/trpc/react'
import { Trash2 } from 'lucide-react'
import { useFieldArray, useForm } from 'react-hook-form'

import type { VideoChapter } from '@coursebuilder/core/schemas'
import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
	Input,
	Label,
	Textarea,
} from '@coursebuilder/ui'

import {
	formatSeconds,
	parseTimecode,
	parseYoutubeChaptersText,
	sortByStartTime,
	validateChapters,
} from './chapter-utils'

type RowFields = {
	timecode: string
	title: string
}

type FormFields = {
	rows: RowFields[]
}

type VideoChaptersEditorProps = {
	videoResourceId: string
	initialChapters?: VideoChapter[] | null
	videoDuration?: number | null
}

function chaptersToRows(chapters: VideoChapter[]): RowFields[] {
	return sortByStartTime(chapters).map((c) => ({
		timecode: formatSeconds(c.startTime),
		title: c.title,
	}))
}

type RowParseError = { index: number; reason: 'timecode' | 'title' }

function rowsToChapters(rows: RowFields[]): {
	chapters: VideoChapter[]
	errors: RowParseError[]
} {
	const errors: RowParseError[] = []
	const chapters: VideoChapter[] = []
	rows.forEach((row, index) => {
		const startTime = parseTimecode(row.timecode)
		if (startTime === null) {
			errors.push({ index, reason: 'timecode' })
			return
		}
		const title = row.title.trim()
		if (!title) {
			errors.push({ index, reason: 'title' })
			return
		}
		chapters.push({ startTime, title })
	})
	return { chapters, errors }
}

export function VideoChaptersEditor({
	videoResourceId,
	initialChapters,
	videoDuration,
}: VideoChaptersEditorProps) {
	const initialRows = React.useMemo(
		() => chaptersToRows(initialChapters ?? []),
		[initialChapters],
	)
	const initialCount = initialRows.length

	const [isOpen, setIsOpen] = React.useState(false)
	const [savedCount, setSavedCount] = React.useState(initialCount)

	React.useEffect(() => {
		setSavedCount(initialCount)
	}, [initialCount])

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger asChild>
				<Button variant="outline" size="sm" type="button">
					{savedCount > 0 ? `Chapters (${savedCount})` : 'Add Chapters'}
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-2xl sm:max-h-[80vh]">
				<DialogHeader>
					<DialogTitle>Chapters</DialogTitle>
				</DialogHeader>
				<ChaptersForm
					key={isOpen ? 'open' : 'closed'}
					videoResourceId={videoResourceId}
					initialRows={initialRows}
					videoDuration={videoDuration}
					onSaved={(count) => {
						setSavedCount(count)
						setIsOpen(false)
					}}
					onCancel={() => setIsOpen(false)}
				/>
			</DialogContent>
		</Dialog>
	)
}

function ChaptersForm({
	videoResourceId,
	initialRows,
	videoDuration,
	onSaved,
	onCancel,
}: {
	videoResourceId: string
	initialRows: RowFields[]
	videoDuration?: number | null
	onSaved: (count: number) => void
	onCancel: () => void
}) {
	const form = useForm<FormFields>({
		defaultValues: { rows: initialRows },
	})

	const { fields, append, remove, replace } = useFieldArray({
		control: form.control,
		name: 'rows',
	})

	const [pasteText, setPasteText] = React.useState('')
	const [pasteFeedback, setPasteFeedback] = React.useState<{
		kind: 'success' | 'partial' | 'error'
		message: string
	} | null>(null)
	const [submitError, setSubmitError] = React.useState<string | null>(null)

	const utils = api.useUtils()
	const { mutateAsync: updateChapters, isPending } =
		api.videoResources.updateChapters.useMutation({
			onSuccess: async () => {
				await utils.videoResources.get.invalidate({ videoResourceId })
			},
		})

	const rows = form.watch('rows')
	const firstChapterWarning = React.useMemo(() => {
		if (!rows.length) return false
		const firstStart = parseTimecode(rows[0]!.timecode)
		return firstStart !== null && firstStart !== 0
	}, [rows])

	const handleAddRow = () => {
		const last = rows[rows.length - 1]
		const lastStart = last ? parseTimecode(last.timecode) : null
		const nextStart = lastStart !== null ? lastStart + 1 : 0
		append({ timecode: formatSeconds(nextStart), title: '' })
	}

	const handleParsePaste = () => {
		const result = parseYoutubeChaptersText(pasteText)
		if (result.chapters.length === 0) {
			setPasteFeedback({
				kind: 'error',
				message:
					'No chapters parsed. Check the timestamp format (e.g. 0:00 Title).',
			})
			return
		}
		replace(chaptersToRows(result.chapters))
		if (result.skippedLines.length === 0) {
			setPasteFeedback({
				kind: 'success',
				message: `Parsed ${result.chapters.length} chapter${result.chapters.length === 1 ? '' : 's'}.`,
			})
		} else {
			setPasteFeedback({
				kind: 'partial',
				message: `Parsed ${result.chapters.length} chapter${result.chapters.length === 1 ? '' : 's'}. Skipped ${result.skippedLines.length} line${result.skippedLines.length === 1 ? '' : 's'}: ${result.skippedLines.slice(0, 3).join(' / ')}${result.skippedLines.length > 3 ? '…' : ''}`,
			})
		}
		setPasteText('')
	}

	const onSubmit = form.handleSubmit(async (values) => {
		setSubmitError(null)

		const { chapters, errors: parseErrors } = rowsToChapters(values.rows)

		if (parseErrors.length > 0) {
			const first = parseErrors[0]!
			setSubmitError(
				first.reason === 'timecode'
					? `Row ${first.index + 1}: invalid timecode (use M:SS or H:MM:SS).`
					: `Row ${first.index + 1}: title is required.`,
			)
			return
		}

		const validationError = validateChapters(chapters, videoDuration)
		if (validationError) {
			setSubmitError(
				validationError.kind === 'duplicate-startTime'
					? `Duplicate startTime ${formatSeconds(validationError.startTime)}.`
					: validationError.kind === 'startTime-exceeds-duration'
						? `startTime ${formatSeconds(validationError.startTime)} exceeds video duration (${formatSeconds(validationError.duration)}).`
						: 'Chapter title cannot be empty.',
			)
			return
		}

		try {
			await updateChapters({ videoResourceId, chapters })
			onSaved(chapters.length)
		} catch (err) {
			setSubmitError(
				err instanceof Error ? err.message : 'Failed to save chapters.',
			)
		}
	})

	return (
		<form onSubmit={onSubmit} data-testid="video-chapters-editor">
			<div className="max-h-[55vh] overflow-y-auto">
				{fields.length === 0 ? (
					<p className="text-muted-foreground mb-3 text-sm">No chapters yet.</p>
				) : (
					<ul className="mb-3 space-y-2">
						{fields.map((field, index) => (
							<li key={field.id} className="flex items-center gap-2">
								<Input
									{...form.register(`rows.${index}.timecode` as const)}
									className="w-24 font-mono text-sm"
									placeholder="0:00"
									aria-label={`Chapter ${index + 1} start time`}
								/>
								<Input
									{...form.register(`rows.${index}.title` as const)}
									className="flex-1 text-sm"
									placeholder="Chapter title"
									aria-label={`Chapter ${index + 1} title`}
								/>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									onClick={() => remove(index)}
									aria-label={`Remove chapter ${index + 1}`}
								>
									<Trash2 className="h-4 w-4" />
								</Button>
							</li>
						))}
					</ul>
				)}

				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={handleAddRow}
				>
					+ Add chapter
				</Button>

				{firstChapterWarning && (
					<p className="text-muted-foreground mt-3 text-xs">
						Heads up: the first chapter does not start at 0:00. Mux will show no
						chapter before it.
					</p>
				)}

				<div className="mt-4 border-t pt-3">
					<Label
						htmlFor={`chapters-paste-${videoResourceId}`}
						className="text-muted-foreground mb-1 block text-xs"
					>
						or paste YouTube chapters
					</Label>
					<Textarea
						id={`chapters-paste-${videoResourceId}`}
						value={pasteText}
						onChange={(e) => setPasteText(e.target.value)}
						placeholder="0:00 Intro&#10;0:22 Section"
						rows={4}
						className="text-sm"
					/>
					<div className="mt-2 flex items-center justify-between gap-2">
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={handleParsePaste}
							disabled={!pasteText.trim()}
						>
							Parse and replace
						</Button>
						{pasteFeedback && (
							<span
								className={
									pasteFeedback.kind === 'error'
										? 'text-destructive text-xs'
										: 'text-muted-foreground text-xs'
								}
								role={pasteFeedback.kind === 'error' ? 'alert' : 'status'}
							>
								{pasteFeedback.message}
							</span>
						)}
					</div>
				</div>
			</div>

			<DialogFooter className="mt-4 flex items-center sm:justify-between">
				{submitError ? (
					<span className="text-destructive text-xs" role="alert">
						{submitError}
					</span>
				) : (
					<span />
				)}
				<div className="flex items-center gap-2">
					<Button
						type="button"
						variant="secondary"
						onClick={onCancel}
						disabled={isPending}
					>
						Cancel
					</Button>
					<Button type="submit" disabled={isPending}>
						{isPending ? 'Saving…' : 'Save chapters'}
					</Button>
				</div>
			</DialogFooter>
		</form>
	)
}
