import type { SessionExtract } from './session-extract.js'

/**
 * MCP prompts. A prompt renders by calling a capability through the shared
 * dispatcher, so it gets the same access checks, rate limit and encoding as
 * a tool call; it never reads content on its own.
 */
export type PromptArgument = {
	readonly name: string
	readonly description: string
	readonly required: boolean
}

export type PromptMessage = {
	readonly role: 'user' | 'assistant'
	readonly content: { readonly type: 'text'; readonly text: string }
}

export type PromptDefinition = {
	readonly name: string
	readonly title: string
	readonly description: string
	readonly arguments: ReadonlyArray<PromptArgument>
	/** The capability call that loads the prompt's content. */
	readonly call: (args: Readonly<Record<string, string>>) => {
		readonly capability: string
		readonly input: Record<string, unknown>
	}
	/** Renders the encoded capability output into messages. */
	readonly render: (output: Record<string, unknown>) => {
		readonly description: string
		readonly messages: ReadonlyArray<PromptMessage>
	}
}

export const COMPANION_RULES = [
	'You are this learner’s study companion for an AI Hero lesson.',
	'Follow the learner’s pace: ask what they want to do next before moving on.',
	'Use the session extract next to the video: when the learner mentions a moment, look up what Matt had on screen at that second with session_extract.',
	'Never reveal the solution unless the learner asks for it. Offer hints first.',
	'When the learner finishes, offer the next lesson from course_outline.',
]

function renderExtract(extract: SessionExtract): string {
	const lines: string[] = []
	for (const session of extract.sessions) {
		for (const entry of session.entries) {
			const at = `[${Math.floor(entry.visibleFrom)}s]`
			switch (entry.kind) {
				case 'userPrompt':
					lines.push(`${at} Matt: ${entry.text}`)
					break
				case 'assistantText':
					lines.push(`${at} Claude: ${entry.text}`)
					break
				case 'interrupt':
					lines.push(`${at} Interrupt: ${entry.text}`)
					break
				case 'skillCall':
					lines.push(
						`${at} Skill ${entry.skill}${entry.args ? ` ${entry.args}` : ''}`,
					)
					break
				case 'toolCall':
					lines.push(
						`${at} Tool ${entry.tool}${entry.summary ? `: ${entry.summary}` : ''}${entry.resultIsError ? ' (error)' : ''}`,
					)
					break
			}
		}
	}
	return lines.join('\n')
}

type LessonOutput = {
	readonly lesson: { readonly title: string }
	readonly workshop: { readonly title: string }
	readonly body: string | null
	readonly transcript: string | null
	readonly solutionAvailable: boolean
	readonly sessionExtract: SessionExtract | null
	readonly links: { readonly lesson: string }
}

/**
 * Loads a lesson, its exercise text and Matt's session extract into the
 * agent's context, with the companion rules. Never the solution.
 */
export const startLesson: PromptDefinition = {
	name: 'start_lesson',
	title: 'Start a lesson',
	description:
		'Load one lesson, its exercise and Matt’s session extract into context, and work through it with the learner as a study companion.',
	arguments: [
		{ name: 'lesson', description: 'Lesson slug or id.', required: true },
		{ name: 'workshop', description: 'Workshop slug or id.', required: false },
	],
	call: (args) => ({
		capability: 'read_lesson',
		input: {
			lesson: args.lesson,
			...(args.workshop ? { workshop: args.workshop } : {}),
			includeSolution: false,
		},
	}),
	render: (output) => {
		// SAFETY: `call` targets read_lesson, so this is its encoded output.
		const lesson = output as unknown as LessonOutput
		const sections = [
			COMPANION_RULES.join('\n'),
			`# ${lesson.lesson.title}\n\nWorkshop: ${lesson.workshop.title}\nLesson page: ${lesson.links.lesson}`,
			lesson.body ? `## Lesson\n\n${lesson.body}` : null,
			lesson.transcript ? `## Video transcript\n\n${lesson.transcript}` : null,
			lesson.sessionExtract
				? `## Matt’s session, timed to the video\n\n${renderExtract(lesson.sessionExtract)}`
				: null,
			lesson.solutionAvailable
				? 'A solution exists. Do not fetch it unless the learner asks.'
				: null,
		].filter((section): section is string => section !== null)

		return {
			description: `Study ${lesson.lesson.title} with the learner.`,
			messages: [
				{
					role: 'user',
					content: { type: 'text', text: sections.join('\n\n') },
				},
			],
		}
	},
}

export const prompts: ReadonlyArray<PromptDefinition> = [startLesson]
