type AnswerLink = {
	optionValue?: string
	href: string
}

export const SKILLS_COURSE_LESSON_ONE_SUBJECT =
	'Your first AI Skills lesson, sent again'
export const SKILLS_COURSE_LESSON_ONE_PREVIEW =
	'Choose the AI workflow path that fits your work.'

export function buildSkillsCourseLessonOneEmail(fields: Record<string, string>) {
	const links = parseAnswerLinks(fields.aih_value_path_answer_links_json)
	const personalUrl = answerUrl(links, 'personal')
	const teamUrl = answerUrl(links, 'team')
	const unsureUrl = answerUrl(links, 'unsure')

	return {
		subject: SKILLS_COURSE_LESSON_ONE_SUBJECT,
		preview: SKILLS_COURSE_LESSON_ONE_PREVIEW,
		body: `Agents work best when you are not just collecting prompts.

Prompts are disposable. Workflows are reusable.

That is what skills give you: a way to teach your agent how you want work done, then reuse that instruction again and again.

This email course gives you a repeatable workflow for working with agents, not a pile of one-off prompts.

Choose the path that best fits what you are trying to do. Your next email will start with the skill and practice step that matches your goal.

**Choose your path:**

[My Own AI Agent Workflows](${personalUrl})

[Team Agent Workflows](${teamUrl})

[Help me choose the right workflow.](${unsureUrl})

Pick one and I will send the next lesson in a few minutes.`,
	}
}

function parseAnswerLinks(value?: string): AnswerLink[] {
	if (!value) throw new Error('Course recovery links are missing')
	const parsed: unknown = JSON.parse(value)
	if (!Array.isArray(parsed)) {
		throw new Error('Course recovery links are invalid')
	}
	return parsed.filter((link): link is AnswerLink =>
		Boolean(
			link &&
				typeof link === 'object' &&
				'href' in link &&
				typeof link.href === 'string' &&
				(!('optionValue' in link) ||
					typeof link.optionValue === 'undefined' ||
					typeof link.optionValue === 'string'),
		),
	)
}

function answerUrl(links: AnswerLink[], optionValue: string) {
	const href = links.find((link) => link.optionValue === optionValue)?.href
	if (!href) throw new Error(`Course recovery link is missing: ${optionValue}`)
	return href
}
