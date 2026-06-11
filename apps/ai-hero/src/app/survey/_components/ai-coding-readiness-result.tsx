import React from 'react'

const READINESS_SURVEY_IDS = new Set([
	'survey-vmlvi',
	'ai-coding-workflow-readiness-check',
])

type ReadinessProfileKey =
	| 'just-poking-around'
	| 'prompt-wrangler'
	| 'workflow-builder'
	| 'team-pilot-lead'
	| 'harness-wizard'

type ReadinessProfile = {
	key: ReadinessProfileKey
	title: string
	summary: string
	nextStep: string
}

type ScoreResult = {
	total: number
	max: number
	axes: Record<string, number>
	profile: ReadinessProfile
}

const profiles: Record<ReadinessProfileKey, ReadinessProfile> = {
	'just-poking-around': {
		key: 'just-poking-around',
		title: 'Just Poking Around',
		summary:
			'You are curious, but you do not have a repeatable AI coding loop yet.',
		nextStep:
			'The next step is not memorizing tool commands. It is getting one small workflow working: pick a safe task, give the agent enough context, review the result, and repeat.',
	},
	'prompt-wrangler': {
		key: 'prompt-wrangler',
		title: 'Prompt Wrangler',
		summary:
			'You are getting value, but the workflow is still mostly one-off prompts.',
		nextStep:
			'That works until the task gets bigger, the context gets weird, or the agent forgets what mattered. Your next win is turning prompts into reusable workflows.',
	},
	'workflow-builder': {
		key: 'workflow-builder',
		title: 'Workflow Builder',
		summary:
			'You are already moving in the right direction: smaller tasks, clearer plans, better handoffs, and more reviewable outputs.',
		nextStep:
			'The next step is turning that into a complete engineering loop, from idea to shipped feature, without lowering your standards.',
	},
	'team-pilot-lead': {
		key: 'team-pilot-lead',
		title: 'Team Pilot Lead',
		summary:
			'Your problem is not just “how do I use AI?” It is “how do we make this safe and useful across a team?”',
		nextStep:
			'Start with one shared workflow. Pick a narrow task, write down the handoff and review rules, then let the team compare results.',
	},
	'harness-wizard': {
		key: 'harness-wizard',
		title: 'Harness Wizard',
		summary:
			'You already have a real loop. You are building the rails around the agent: context, checks, review, and feedback into the next run.',
		nextStep:
			'This is where AI starts acting less like a chatbot and more like a weird junior engineer you can actually manage.',
	},
}

const parseAnswer = (answer: unknown) => {
	const raw = Array.isArray(answer) ? answer[0] : answer
	if (typeof raw !== 'string') return null
	const [, scoreRaw, axis] = raw.split('~')
	const score = Number(scoreRaw)
	if (!axis || Number.isNaN(score)) return null
	return { score, axis, raw }
}

const scoreAnswers = (answers: Record<string, unknown>): ScoreResult => {
	const axes: Record<string, number> = {}
	let total = 0

	for (const answer of Object.values(answers)) {
		const parsed = parseAnswer(answer)
		if (!parsed) continue
		total += parsed.score
		axes[parsed.axis] = (axes[parsed.axis] ?? 0) + parsed.score
	}

	const teamAnswer = answers.aih_readiness_team
	const teamRaw = Array.isArray(teamAnswer) ? teamAnswer[0] : teamAnswer
	const isTeamLead = teamRaw === 'team-lead~6~team'
	const isTeamWeighted = (axes.team ?? 0) >= 5
	const handoff = axes.handoff ?? 0
	const review = axes.review ?? 0
	const system = axes.system ?? 0
	const planning = axes.planning ?? 0
	const scope = axes.scope ?? 0
	const usage = axes.usage ?? 0

	let profile: ReadinessProfile = profiles['prompt-wrangler']

	if (isTeamLead || isTeamWeighted) {
		profile = profiles['team-pilot-lead']
	} else if (total >= 40 && review >= 5 && system >= 5 && handoff >= 5) {
		profile = profiles['harness-wizard']
	} else if (total >= 29 && planning >= 4 && scope >= 4) {
		profile = profiles['workflow-builder']
	} else if (total <= 23 || usage <= 2) {
		profile = profiles['just-poking-around']
	} else {
		profile = profiles['prompt-wrangler']
	}

	return {
		total,
		max: 51,
		axes,
		profile,
	}
}

export function isAiCodingReadinessSurvey(surveyId: string) {
	return READINESS_SURVEY_IDS.has(surveyId)
}

export function AiCodingReadinessResult({
	answers,
}: {
	answers: Record<string, unknown>
}) {
	const result = scoreAnswers(answers)
	const percent = Math.round((result.total / result.max) * 100)
	const sortedAxes = Object.entries(result.axes).sort((a, b) => b[1] - a[1])
	const topAxes = sortedAxes.slice(0, 3)

	return (
		<div className="mx-auto flex max-w-2xl flex-col gap-6 py-10 text-center">
			<div className="space-y-3">
				<p className="text-muted-foreground text-sm font-medium uppercase tracking-wide">
					Your AI coding workflow type
				</p>
				<h2 className="text-4xl font-bold tracking-tight">
					{result.profile.title}
				</h2>
				<p className="text-muted-foreground text-lg leading-relaxed">
					{result.profile.summary}
				</p>
			</div>

			<div className="border-border bg-card rounded-xl border p-5 text-left shadow-sm">
				<div className="mb-3 flex items-center justify-between gap-4 text-sm">
					<span className="font-medium">Readiness score</span>
					<span className="text-muted-foreground">
						{result.total} / {result.max}
					</span>
				</div>
				<div className="bg-muted h-3 overflow-hidden rounded-full">
					<div
						className="h-full rounded-full bg-blue-600 transition-all duration-700"
						style={{ width: `${percent}%` }}
					/>
				</div>
			</div>

			<div className="border-border bg-card rounded-xl border p-5 text-left shadow-sm">
				<h3 className="mb-2 font-semibold">What to do next</h3>
				<p className="text-muted-foreground leading-relaxed">
					{result.profile.nextStep}
				</p>
			</div>

			{topAxes.length > 0 ? (
				<div className="text-muted-foreground text-sm">
					Strongest signals: {topAxes.map(([axis]) => axis).join(', ')}
				</div>
			) : null}
		</div>
	)
}
