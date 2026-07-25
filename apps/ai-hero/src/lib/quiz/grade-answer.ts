/**
 * Grades one submitted answer against a question's answer key.
 *
 * Exact set match, all or nothing — a proper subset of a multi-answer key is
 * wrong, and so is a superset. Order does not matter. Both sides are normalized
 * to arrays so a caller may pass either shape for either argument; this matters
 * because the same function grades in the browser and on the server, and the two
 * must never disagree about the same answer.
 */
export function gradeAnswer(
	correct: string | string[],
	answer: string | string[],
): boolean {
	const correctAnswers = Array.isArray(correct) ? correct : [correct]
	const submitted = Array.isArray(answer) ? answer : [answer]

	return (
		correctAnswers.length === submitted.length &&
		correctAnswers.every((correctAnswer) => submitted.includes(correctAnswer))
	)
}
