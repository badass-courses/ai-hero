# Inline lesson quizzes

This is the single entry point for how quizzes work. It exists so you do not
have to trace three repos to answer "where do quiz answers go" or "why did the
choices shuffle". Effort history and decisions live in
`.brain/projects/quiz-component/quiz-component-brief.svx`.

A quiz has three moving parts:

1. **MDX components** — `Quiz` / `QuizQuestion` render inline in a lesson body
   and grade in the browser (`src/components/mdx/quiz.tsx`,
   `quiz-question-client.tsx`, schema in `quiz-schema.ts`).
2. **Course-sync extraction** — sync parses the lesson MDX source (it does not
   execute it) and derives one `question` content resource per inline question
   (`src/course-sync/quiz-question-extraction.ts`, ids minted in
   `control-plane.ts`).
3. **Answer endpoint** — `trpc.quiz.answer` re-grades on the server from the
   synced question row and upserts one response row per learner per question
   (`src/trpc/api/routers/quiz.ts`, core logic in `src/lib/quiz/answer.ts`).

## Authoring contract

Questions are authored inline in the lesson MDX. There is no separate record to
create. The agent-facing contract Matt authors against is published at
<https://aihero-quiz-authoring.wzrrd.sh/>; the schema that enforces it is
`QuizQuestionDataSchema` in `src/components/mdx/quiz-schema.ts`.

```mdx
<Quiz>
  <QuizQuestion
    data={{
      id: 'context-window-limit',
      question: 'What happens when a conversation exceeds the context window?',
      type: 'multiple-choice',
      choices: [
        { answer: 'truncated', label: 'The oldest messages are dropped' },
        { answer: 'error', label: 'The request fails' },
        { answer: 'summarized', label: 'The model summarizes automatically' },
      ],
      correct: 'truncated',
      answer: 'The model can only attend to what fits in the window…',
    }}
  />
</Quiz>
```

| Field      | Required        | Notes                                                                                                                     |
| ---------- | --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `id`       | for persistence | Stable key for answer history. Optional to render; without it nothing is saved.                                           |
| `question` | yes             | The prompt.                                                                                                               |
| `type`     | yes             | Only `'multiple-choice'` exists.                                                                                          |
| `choices`  | yes             | Min 2. `answer` values must be unique; `label` is the display text.                                                       |
| `correct`  | yes             | String or array of strings. Each must match a choice `answer`. Array = multi-select, graded exact-set, no partial credit. |
| `answer`   | yes             | The explanation shown after submitting.                                                                                   |

Validation failures render an error card in place of the question and log
`quiz.authoring.invalid-question-data`. A missing `id` or a duplicated `id`
within one `Quiz` renders with an "answers will not be saved" warning and logs
`quiz.authoring.missing-question-id` / `quiz.authoring.duplicate-question-id`.
Sync is stricter: extraction throws on a missing or duplicate `id`, and rejects
spreads, computed keys, and any non-static `data` — it parses source, it does
not run it.

## Identity: what a question id is, and the rewrite trap

The authored `id` is the durable identity of a question. Sync mints the content
resource id deterministically (`control-plane.ts`):

```
sync_question_<sha256(bindingId:question:authoredId).slice(0,24)>
```

and stores the authored id at `fields.courseSync.sourceQuestionId` on that
resource. The authored id must be unique across every lesson in the same
course-sync binding: the resource id has no lesson component, and manifest
validation rejects cross-lesson reuse with `DUPLICATE_QUIZ_QUESTION_ID` before
sync stages anything. Two lessons therefore never attach or overwrite the same
question resource; the whole sync fails instead. The endpoint's lesson join
only verifies that the resolved question is attached to the submitted lesson.
It does not make authored ids lesson-scoped. Do not reuse an authored question
id anywhere else in the same course binding.

**The trap:** rewording a question is safe — same `id`, same resource, history
intact. **Changing the `id` silently forks history.** Sync mints a new resource,
new answers accrue there, and the old rows still exist under the old
`questionId` with nothing marking them related. Nothing fails, nothing warns.
If a question's meaning changes so much that old answers are invalid, changing
the id is correct — just know that is what it does.

## Where answers land

Table **`AI_QuestionResponse`** (schema from
`@coursebuilder/adapter-drizzle`, `question-response.ts`). One row per learner
per question, enforced by the unique index
`survey_question_respondent_unique (surveyId, questionId, respondentKey)` —
resubmits upsert in place (`onDuplicateKeyUpdate`), they never append.

| Column            | Value                                              |
| ----------------- | -------------------------------------------------- |
| `surveyId`        | the **lesson's** content resource id               |
| `questionId`      | the `sync_question_<hash>` content resource id     |
| `respondentKey`   | always `user:<userId>`                             |
| `surveySessionId` | always `null` for quizzes                          |
| `userId`          | the session user                                   |
| `fields`          | `{ answer: string \| string[], correct: boolean }` |

**Who gets saved:** persistence is gated on login (Joel, 2026-07-25: "gate the
saving, not the answering"). A logged-out learner still answers, still gets
graded, still sees the explanation — nothing is recorded. There is no anonymous
attribution: no cookie-minted respondent, no `session:` fallback. The endpoint
is a `protectedProcedure`, so bypassing the client guard cannot produce an
anonymous write. Questions with no `id` (or a duplicated one) are likewise
graded but never saved.

Persistence is best-effort by design: a failed save is reported and swallowed
(`bestEffortQuizPersistence` in `src/lib/quiz/quiz-machine.ts`) so a database
problem never costs the learner their grading feedback.

## Querying correct rates

```sql
SELECT
	qr.questionId,
	cr.fields->>'$.courseSync.sourceQuestionId' AS authoredId,
	COUNT(*) AS responses,
	SUM(qr.fields->>'$.correct' = 'true') AS correct,
	ROUND(AVG(qr.fields->>'$.correct' = 'true'), 2) AS correctRate
FROM AI_QuestionResponse qr
JOIN AI_ContentResource cr ON cr.id = qr.questionId
WHERE qr.surveyId = '<lesson content resource id>'
	AND qr.deletedAt IS NULL
GROUP BY qr.questionId, authoredId;
```

No MDX parsing needed — that is the point of derived storage. Because rows
upsert, this counts learners, not attempts.

## Server grading

The client posts `{ lessonId, questionId, answer }` where `questionId` is the
**authored** id. The server resolves the synced question row, reads `correct`
from it, and grades with the same shared `gradeAnswer`
(`src/lib/quiz/grade-answer.ts`) the component uses — exact-set match, all or
nothing. A client-supplied `correct` is never accepted. An authored id with no
synced resource is a `NOT_FOUND` error, not a silent insert: it means sync has
not run yet or the body drifted. During the window between authoring and sync,
learners see grading but saves fail (best-effort, invisible to them).

## Observability

Every stage logs under `quiz.answer.*`: `received` → `resolved` → `graded` →
`saved`, with `identity.failed` / `resolve.failed` / `save.failed` branches.
Authoring problems log under `quiz.authoring.*`. Each mutation carries an
`answerAttemptId` (also returned to the client). Trace one answer end to end:

```
joelclaw otel search '<answerAttemptId>' -h 1 -n 50
```

## MDX registration

Components reach lesson bodies through `src/utils/compile-mdx.tsx`: a dynamic
import near the top, then an entry in the component map that threads
`context.lessonId` into `QuizQuestion` (search for `QuizQuestion` in that
file). That lessonId thread is what tells the component where to post; the
`/quiz-prototype` page has no lesson resource, so it renders and grades but
never posts — it is a fixture, not a bug. Adding a new MDX component follows
the same two-step pattern.

## Sharp edges

- **Setting `correct` shuffles the choices.** `@coursebuilder/survey`'s
  `loadQuestion` shuffles whenever `correct` is present
  (`survey-machine.ts`, `shuffle(question.choices)`). Do not author choices
  whose labels depend on order ("both A and B").
- **The package's multi-select guard has a subset bug** — it accepts a proper
  subset of the correct answers as correct (no length check in
  `answeredCorrectly`). AI Hero does not hit it: `quizMachine`
  (`src/lib/quiz/quiz-machine.ts`) overrides that guard via
  `machine.provide()` with the shared exact-set `gradeAnswer`, and the server
  grades independently. The bug is still live for anything using the package
  directly.
- **Version pin:** this app pins `@coursebuilder/survey@^1.0.5` (installed
  1.0.5) while the monorepo source is at 1.0.13. The guard override and the
  grading tests (`quiz-machine.test.ts`) are the safety net if the pin moves —
  run them before bumping.
- **Sync timing:** answers only persist after course-sync has minted the
  question resource. A brand-new question in a draft lesson silently no-ops
  saves until the next sync run.
