import type { Metadata } from 'next'
import LayoutClient from '@/components/layout-client'
import { compileMDX } from '@/utils/compile-mdx'

export const metadata: Metadata = {
	title: 'Inline Quiz Development Fixture | AI Hero',
	description: 'A development fixture for quizzes inside AI Hero lessons.',
}

const quizFixtureMdx = `
# Inline quiz development fixture

This page exercises the same MDX path used by lesson bodies.

<Quiz>
  <QuizQuestion data={{
    id: "single-answer",
    question: "What is the strongest first move when an agent reports that a bug is fixed?",
    type: "multiple-choice",
    choices: [
      { answer: "a", label: "Ask it to explain the code in more detail" },
      { answer: "b", label: "Reproduce the original failure and run the relevant check" },
      { answer: "c", label: "Accept the fix if the diff looks reasonable" }
    ],
    correct: "b",
    answer: "A plausible diff is not proof. Reproduce the failure, then rerun the same path after the change.",
    shuffleChoices: false
  }} />

  <QuizQuestion data={{
    id: "multi-answer",
    question: "Which items belong in a useful final report? Select all that apply.",
    type: "multiple-choice",
    choices: [
      { answer: "files", label: "Files changed" },
      { answer: "checks", label: "Checks run and their results" },
      { answer: "confidence", label: "A confident claim with no evidence" },
      { answer: "risk", label: "Remaining risks" }
    ],
    correct: ["files", "checks", "risk"],
    answer: "A useful report names the changed files, verification results, and remaining risks.",
    shuffleChoices: false
  }} />

  <QuizQuestion data={{
    id: "invalid-fixture",
    question: "This fixture is intentionally malformed",
    type: "multiple-choice",
    correct: "missing-choice",
    answer: "The component should show an inline error instead of crashing the lesson."
  }} />
</Quiz>
`

/**
 * Development fixture for the inline quiz components.
 *
 * Kept deliberately rather than deleted: it compiles a real MDX string through
 * `compileMDX`, the same path a lesson body takes, so it exercises the authoring
 * contract end to end rather than just rendering the components directly. Its
 * fixtures cover single answer, multi-select, and intentionally invalid data.
 *
 * Not linked from navigation and carries no persistence.
 */
export default async function QuizPrototypePage() {
	const { content } = await compileMDX(quizFixtureMdx)

	return (
		<LayoutClient withContainer>
			<main className="px-5 py-10 sm:py-16 md:px-10">
				<article className="prose prose-hr:border-border dark:prose-invert prose-a:text-primary sm:prose-lg mx-auto max-w-3xl">
					{content}
				</article>
			</main>
		</LayoutClient>
	)
}
