import { z } from 'zod'

const LessonVideoTranscriptRowsSchema = z.array(
	z.object({ transcript: z.string().nullable() }),
)

export type LessonVideoTranscriptParseResult =
	| { status: 'available'; transcript: string }
	| { status: 'missing'; transcript: null }
	| { status: 'invalid'; transcript: null; error: z.ZodError }

export function parseLessonVideoTranscriptRows(
	rows: unknown,
): LessonVideoTranscriptParseResult {
	const parsed = LessonVideoTranscriptRowsSchema.safeParse(rows)

	if (!parsed.success) {
		return { status: 'invalid', transcript: null, error: parsed.error }
	}

	const transcript = parsed.data[0]?.transcript ?? null
	return transcript === null
		? { status: 'missing', transcript: null }
		: { status: 'available', transcript }
}
