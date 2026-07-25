export function gradeAnswer(
	correct: string | string[],
	answer: string | string[],
): boolean {
	if (Array.isArray(correct)) {
		const submitted = Array.isArray(answer) ? answer : [answer]
		return (
			correct.length === submitted.length &&
			correct.every((correctAnswer) => submitted.includes(correctAnswer))
		)
	}

	return correct === answer
}
