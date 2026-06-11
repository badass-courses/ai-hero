import { captureFrontQuickQuestion } from './capture-quick-question'
import type { CaptureMarketingRepository } from './capture-contact-event'

export type FrontQuickQuestionCsvCaptureResult = {
	mode: 'front-quick-question-csv-capture'
	dryRun: boolean
	privacy: {
		rawPayloadIncluded: false
		rawEmailsIncluded: false
	}
	input: {
		rows: number
		processableRows: number
		uniqueConversations: number
		uniqueSenderEmails: number
	}
	result: {
		captured: number
		idempotentNoops: number
		skipped: number
		failed: number
	}
	failures: Array<{
		rowNumber: number
		conversationId?: string
		messageId?: string
		error: string
	}>
}

type FrontQuickQuestionCsvRow = {
	rowNumber: number
	conversationId: string
	messageId?: string
	messageCreatedAt: string
	senderEmail?: string
	senderName?: string
	frontContactId?: string
	answer: string
	isFollowUp: boolean
}

export async function captureFrontQuickQuestionCsv(args: {
	repository: CaptureMarketingRepository
	csv: string
	dryRun?: boolean
	limit?: number
	now?: string
}): Promise<FrontQuickQuestionCsvCaptureResult> {
	const rows = parseFrontQuickQuestionCsv(args.csv)
	const selectedRows = rows.slice(0, args.limit ?? rows.length)
	const processableRows = selectedRows.filter(isProcessableRow)
	const uniqueConversations = new Set(
		processableRows.map((row) => row.conversationId),
	).size
	const uniqueSenderEmails = new Set(
		processableRows
			.map((row) => normalizeEmail(row.senderEmail))
			.filter((email): email is string => Boolean(email)),
	).size

	const result: FrontQuickQuestionCsvCaptureResult = {
		mode: 'front-quick-question-csv-capture',
		dryRun: Boolean(args.dryRun),
		privacy: { rawPayloadIncluded: false, rawEmailsIncluded: false },
		input: {
			rows: selectedRows.length,
			processableRows: processableRows.length,
			uniqueConversations,
			uniqueSenderEmails,
		},
		result: {
			captured: 0,
			idempotentNoops: 0,
			skipped: selectedRows.length - processableRows.length,
			failed: 0,
		},
		failures: [],
	}

	if (args.dryRun) return result

	for (const row of processableRows) {
		try {
			const capture = await captureFrontQuickQuestion({
				repository: args.repository,
				input: {
					conversationId: row.conversationId,
					messageId: row.messageId,
					messageCreatedAt: row.messageCreatedAt,
					senderEmail: row.senderEmail,
					senderName: row.senderName,
					frontContactId: row.frontContactId,
					text: row.answer,
					isFollowUp: row.isFollowUp,
					privacyLevel: 'internal',
				},
				now: args.now,
			})
			if (capture.idempotentNoop) result.result.idempotentNoops += 1
			else result.result.captured += 1
		} catch (error) {
			result.result.failed += 1
			result.failures.push({
				rowNumber: row.rowNumber,
				conversationId: row.conversationId,
				messageId: row.messageId,
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	return result
}

function parseFrontQuickQuestionCsv(csv: string): FrontQuickQuestionCsvRow[] {
	const records = parseCsv(csv)
	const seenConversations = new Set<string>()
	return records.map((record, index) => {
		const conversationId = record['Conversation ID']?.trim() ?? ''
		const isFollowUp = seenConversations.has(conversationId)
		if (conversationId) seenConversations.add(conversationId)
		return {
			rowNumber: index + 2,
			conversationId,
			messageId: record['Message ID']?.trim() || undefined,
			messageCreatedAt:
				record['Message Created At UTC']?.trim() ||
				record['Conversation Created At UTC']?.trim() ||
				new Date().toISOString(),
			senderEmail: record['Sender Email']?.trim() || undefined,
			senderName: record['Sender Name']?.trim() || undefined,
			frontContactId: record['Front Contact ID']?.trim() || undefined,
			answer: record.Answer?.trim() ?? '',
			isFollowUp,
		}
	})
}

function isProcessableRow(row: FrontQuickQuestionCsvRow) {
	return Boolean(
		row.conversationId && row.messageCreatedAt && row.answer.trim(),
	)
}

function normalizeEmail(value?: string | null) {
	const normalized = value?.trim().toLowerCase()
	return normalized && normalized.includes('@') ? normalized : undefined
}

function parseCsv(text: string): Array<Record<string, string>> {
	const rows: string[][] = []
	let row: string[] = []
	let cell = ''
	let quoted = false
	for (let index = 0; index < text.length; index++) {
		const char = text[index]
		const next = text[index + 1]
		if (quoted && char === '"' && next === '"') {
			cell += '"'
			index += 1
		} else if (char === '"') {
			quoted = !quoted
		} else if (!quoted && char === ',') {
			row.push(cell)
			cell = ''
		} else if (!quoted && (char === '\n' || char === '\r')) {
			if (char === '\r' && next === '\n') index += 1
			row.push(cell)
			cell = ''
			if (row.some((value) => value !== '')) rows.push(row)
			row = []
		} else {
			cell += char
		}
	}
	row.push(cell)
	if (row.some((value) => value !== '')) rows.push(row)
	const header = rows.shift() ?? []
	return rows.map((values) =>
		Object.fromEntries(
			header.map((field, index) => [field, values[index] ?? '']),
		),
	)
}
