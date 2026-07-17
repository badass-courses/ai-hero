import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { db } from '@/db'
import {
	contact,
	contactEvent,
	contactLink,
	contactState,
	contentResource,
	contentResourceResource,
	googleAdsSignupConversionUpload,
	nextAction,
	providerIdentity,
	sideEffectIntent,
	stateTransition,
} from '@/db/schema'
import { captureFrontQuickQuestionCsv } from '@/lib/subscriber-marketing/capture-front-quick-question-csv'
import { captureFrontQuickQuestion } from '@/lib/subscriber-marketing/capture-quick-question'
import {
	linkAiHeroUserIdentities,
	linkKitSubscriberIdentities,
	previewContentReadContactEvents,
	previewShortlinkClickContactEvents,
	validateContentReadAllowWriteOptions,
	writeContentReadContactEvents,
} from '@/lib/subscriber-marketing/contact-event-normalizer-preview'
import { renderContactEventReviewHtml } from '@/lib/subscriber-marketing/contact-event-review-page'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import {
	cleanupLearnerFlowCanary,
	inspectLearnerFlowCanary,
	seedLearnerFlowCanary,
	tickLearnerFlowCanary,
	type LearnerFlowCanaryRepository,
	type LearnerFlowCanaryResidue,
} from '@/lib/subscriber-marketing/learner-flow-canary'
import { learnerFlowCanaryEmailSql } from '@/lib/subscriber-marketing/learner-flow-canary-exclusion'
import { queryLearnerFlowCohort } from '@/lib/subscriber-marketing/learner-flow-cohort'
import {
	classifyLearnerFlowContact,
	type LearnerFlowStuckCause,
} from '@/lib/subscriber-marketing/learner-flow-classifier'
import { DrizzleOperatorLookupRepository } from '@/lib/subscriber-marketing/drizzle-operator-lookup-repository'
import { DrizzlePurchasePreviewRepository } from '@/lib/subscriber-marketing/drizzle-purchase-preview-repository'
import { previewMatchedPurchaserValuePaths } from '@/lib/subscriber-marketing/matched-purchaser-value-path-preview'
import {
	lookupSubscriberMarketingContact,
	previewSubscriberMarketingReplay,
	type OperatorLookupInput,
} from '@/lib/subscriber-marketing/operator-lookup'
import { buildContactEventProductionReceipt } from '@/lib/subscriber-marketing/production-receipt'
import { previewPurchaseCorrelation } from '@/lib/subscriber-marketing/purchase-preview'
import { previewSeenContent } from '@/lib/subscriber-marketing/seen-content'
import { syncSeenContentKitFieldsForContactSnapshot } from '@/lib/subscriber-marketing/seen-content-kit-sync'
import { previewShadowFieldCandidates } from '@/lib/subscriber-marketing/shadow-field-candidates'
import { previewShadowFieldsForContactSnapshot } from '@/lib/subscriber-marketing/shadow-field-planner'
import { syncShadowFieldsForContactSnapshot } from '@/lib/subscriber-marketing/shadow-field-sync'
import {
	buildSignupGapPreview,
	fetchKitSignupGapPageWithRetry,
	normalizeSignupGapEmail,
	replaySignupGap,
	signupGapPreviewForOutput,
	type SignupGapKitSubscriber,
	type SignupGapPreview,
} from '@/lib/subscriber-marketing/signup-gap-recovery'
import { replanBlockedValuePathEmailIntents } from '@/lib/subscriber-marketing/value-path-intent-replan'
import {
	cleanupLearnerFlowStuckFixture,
	createLearnerFlowStuckFixture,
	learnerFlowFixtureId,
} from '@/lib/subscriber-marketing/learner-flow-fixture'
import {
	checkLearnerFlowSignupGap,
	isTier1SignupGapReplay,
	partitionLearnerFlowUnstickItems,
} from '@/lib/subscriber-marketing/learner-flow-unstick'
import { previewTeamKitProjection } from '@/lib/subscriber-marketing/team-kit-projection'
import {
	CONTACT_STATE_SCHEMA_VERSION,
	type ContactState,
	type Provider,
} from '@/lib/subscriber-marketing/types'
import { getValuePathAnswerPages } from '@/lib/subscriber-marketing/value-path-answer-page'
import { importValuePathContentResources } from '@/lib/subscriber-marketing/value-path-content-import'
import { previewValuePathContentImport } from '@/lib/subscriber-marketing/value-path-content-import-preview'
import { backfillMissingValuePathCompletedAt } from '@/lib/subscriber-marketing/value-path-completed-at-backfill'
import { isValuePathIntentCompleted } from '@/lib/subscriber-marketing/value-path-completion'
import { progressValuePathDrips } from '@/lib/subscriber-marketing/value-path-drip-progression'
import {
	executePendingValuePathEmailIntents,
	parseExecutorList,
	parseExecutorMode,
} from '@/lib/subscriber-marketing/value-path-email-executor'
import {
	DEFAULT_GATE_D_ALLOWED_ACTIONS,
	DEFAULT_GATE_D_MAX_SENDS_PER_RUN,
	DEFAULT_GATE_D_PREAUTHORIZED_REVIEW_REASONS,
	DEFAULT_GATE_D_RETRY_POLICY,
	DEFAULT_GATE_D_STOP_REASONS,
	gateDActivationObjectKey,
	gateDActivePointerKey,
	hashEmail,
	normalizeGateDRuntimeAllowlist,
	readActiveGateDRuntimeAllowlist,
	resolveGateDPreAuthorizedReviewReasons,
	writeGateDRuntimeAllowlist,
	type GateDAuthorizationMode,
	type GateDRuntimeAllowlist,
} from '@/lib/subscriber-marketing/value-path-gate-d-allowlist'
import {
	previewValuePathGateDCandidates,
	type GateDCandidatePreview,
	type GateDCandidatePreviewItem,
	type ContactMatchEvidence,
	type QuickQuestionReplyEvidence,
	type SkillsFormSubscriberEvidence,
} from '@/lib/subscriber-marketing/value-path-gate-d-candidates'
import { startValuePathGateDActivation } from '@/lib/subscriber-marketing/value-path-gate-d-start'
import { previewValuePathForContactSnapshot } from '@/lib/subscriber-marketing/value-path-planner'
import {
	evaluateValuePathMovement,
	resolveGateDRunState,
} from '@/lib/subscriber-marketing/value-path-run-state'
import {
	previewSkillsWorkflowValuePathQa,
	type ValuePathTeamShareLinkMap,
} from '@/lib/subscriber-marketing/value-path-qa-preview'
import {
	getLearnerFlowReport,
	LEARNER_FLOW_REPORT_REDIS_KEY,
} from '@/lib/learner-flow-report'
import { redis } from '@/server/redis-client'
import { and, count, desc, eq, gte, inArray } from 'drizzle-orm'

const providers = ['fixture', 'front', 'kit', 'ai-hero'] as const
const [command, ...args] = process.argv.slice(2)

const SKILLS_WORKFLOW_PATH_SLUGS = [
	'ai-hero-skills-workflow',
	'ai-hero-skills-team-workflow',
]
const SKILLS_WORKFLOW_EMAIL_RESOURCE_IDS = [
	...Array.from(
		{ length: 7 },
		(_, index) => `ai-hero-skills-workflow.email-${index}`,
	),
	...Array.from(
		{ length: 7 },
		(_, index) => `ai-hero-skills-team-workflow.team-email-${index}`,
	),
]
const SKILLS_WORKFLOW_KIT_SEQUENCE_IDS = Array.from(
	{ length: 14 },
	(_, index) => String(2757199 + index),
)

const VALUE_PATH_COMPLETION_SURVEY_SPEC = {
	survey: {
		id: 'survey-skills-workflow-completion',
		type: 'survey' as const,
		fields: {
			title: 'Skills Workflow Completion',
			slug: 'skills-workflow-completion',
			state: 'published' as const,
			visibility: 'unlisted' as const,
			afterCompletionMessages: {
				askForEmail: {
					title: 'Want your certificate?',
					description:
						'Enter your email so we can connect these answers to your Value Path progress.',
				},
				neutral: {
					default: 'Answer saved.',
					last: 'Done. Your answers are saved.',
				},
				correct: {
					default: 'Answer saved.',
					last: 'Done. Your answers are saved.',
				},
				incorrect: {
					default: 'Answer saved.',
					last: 'Done. Your answers are saved.',
				},
			},
		},
	},
	questions: [
		{
			id: 'question-skills-workflow-completion-tried-real-task',
			position: 0,
			fields: {
				slug: 'aih_value_path_completion_tried_real_task',
				question: 'Did you try the workflow on a real task?',
				type: 'multiple-choice' as const,
				required: true,
				allowMultiple: false,
				shuffleChoices: false,
				choices: [
					{ label: 'Yes', answer: 'yes' },
					{ label: 'Not yet', answer: 'not_yet' },
				],
			},
		},
		{
			id: 'question-skills-workflow-completion-progress-state',
			position: 1,
			fields: {
				slug: 'aih_value_path_completion_progress_state',
				question: 'What changed after going through this?',
				type: 'multiple-choice' as const,
				required: true,
				allowMultiple: false,
				shuffleChoices: false,
				choices: [
					{
						label: 'I have a repeatable workflow',
						answer: 'i_have_a_repeatable_workflow',
					},
					{
						label: 'I understand the steps',
						answer: 'i_understand_the_steps',
					},
					{
						label: 'I still need practice',
						answer: 'i_still_need_practice',
					},
					{ label: 'I got stuck', answer: 'i_got_stuck' },
				],
			},
		},
		{
			id: 'question-skills-workflow-completion-next-path',
			position: 2,
			fields: {
				slug: 'aih_value_path_next_path_interest',
				question: 'What do you want help with next?',
				type: 'multiple-choice' as const,
				required: true,
				allowMultiple: false,
				shuffleChoices: false,
				choices: [
					{ label: 'Ship first AI feature', answer: 'ship_first_ai_feature' },
					{
						label: 'Improve existing codebase',
						answer: 'improve_existing_codebase',
					},
					{ label: 'Run agents safely AFK', answer: 'run_agents_safely_afk' },
					{ label: 'Team workflows', answer: 'team_workflows' },
					{
						label: 'AI fundamentals and judgment',
						answer: 'ai_fundamentals_judgment',
					},
				],
			},
		},
		{
			id: 'question-skills-workflow-completion-blocker',
			position: 3,
			fields: {
				slug: 'aih_value_path_completion_blocker',
				question: 'What is most likely to stop you from using this?',
				type: 'multiple-choice' as const,
				required: true,
				allowMultiple: false,
				shuffleChoices: false,
				choices: [
					{ label: 'Unclear task scope', answer: 'unclear_task_scope' },
					{
						label: 'Hard to review agent work',
						answer: 'hard_to_review_agent_work',
					},
					{ label: 'Team trust', answer: 'team_trust' },
					{ label: 'Tooling setup', answer: 'tooling_setup' },
					{ label: 'Not enough time', answer: 'not_enough_time' },
					{ label: 'Something else', answer: 'something_else' },
				],
			},
		},
		{
			id: 'question-skills-workflow-completion-remaining-friction',
			position: 4,
			fields: {
				slug: 'aih_value_path_completion_remaining_friction',
				question:
					'What part of using this workflow still feels confusing, risky, or hard to apply in your own codebase?',
				type: 'essay' as const,
				required: false,
				allowMultiple: false,
				shuffleChoices: false,
			},
		},
	],
} as const

if (command === 'lookup') {
	const input = parseLookupInput(args)
	const repository = await createLookupRepository()
	const result = await lookupSubscriberMarketingContact({ repository, input })
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'replay-preview') {
	const contactId = readFlag(args, '--contact-id')
	const eventId = readFlag(args, '--event-id')
	if (!contactId) printUsageAndExit()
	const repository = await createLookupRepository()
	const result = await previewSubscriberMarketingReplay({
		repository,
		contactId,
		eventId,
	})
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'signup-gap-preview') {
	const preview = await buildSignupGapOperatorPreview({
		formId: requireFormId(args),
		from: requireFlag(args, '--from'),
		to: requireFlag(args, '--to'),
	})
	console.log(JSON.stringify(signupGapPreviewForOutput(preview), null, 2))
} else if (command === 'signup-gap-replay') {
	if (!args.includes('--allow-write') || args.includes('--dry-run')) {
		printUsageAndExit()
	}
	const preview = await buildSignupGapOperatorPreview({
		formId: requireFormId(args),
		from: requireFlag(args, '--from'),
		to: requireFlag(args, '--to'),
	})
	console.error(
		'WARNING: each emitted replay enters the live drip and leads to a real email-0 send.',
	)
	const repository = await createCaptureRepository()
	const { inngest } = await import('@/inngest/inngest.server')
	const result = await replaySignupGap({
		preview,
		source: readFlag(args, '--source') ?? 'signup-gap-replay',
		hasExistingIdentity: async (candidate) => {
			if (await repository.findContactByEmail(candidate.email)) return true
			return Boolean(
				await repository.findProviderIdentity(
					'kit',
					candidate.kitSubscriberId,
				),
			)
		},
		emit: (event) => inngest.send(event),
	})
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'learner-flow-fixture-stuck') {
	const allowWrite = args.includes('--allow-write')
	if (allowWrite && args.includes('--dry-run')) printUsageAndExit()
	const repository = await createCaptureRepository()
	const result = args.includes('--cleanup')
		? await cleanupLearnerFlowStuckFixture({
				repository,
				contactId: requireFlag(args, '--contact-id'),
				allowWrite,
			})
		: await createLearnerFlowStuckFixture({
				repository,
				fixtureId:
					readFlag(args, '--fixture-id') ?? learnerFlowFixtureId(),
				allowWrite,
			})
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'learner-flow-canary') {
	const allowWrite = args.includes('--allow-write')
	if (allowWrite && args.includes('--dry-run')) printUsageAndExit()
	if (args.includes('--stalled') && !args.includes('--seed')) printUsageAndExit()
	const repository = await createLearnerFlowCanaryRepository()
	const now = readFlag(args, '--now')
	const result = args.includes('--cleanup')
		? await cleanupLearnerFlowCanary({ repository, allowWrite })
		: args.includes('--status')
			? await inspectLearnerFlowCanary({ repository, now })
			: args.includes('--seed')
				? await seedLearnerFlowCanary({
						repository,
						allowWrite,
						stalled: args.includes('--stalled'),
						now,
					})
				: await tickLearnerFlowCanary({
						repository,
						allowWrite,
						now,
						advance: async ({ intent, now: progressionNow }) => {
							const allowlist = await requireActiveGateDAllowlist()
							return progressValuePathDrips({
								repository,
								allowlist,
								completedIntents: [intent],
								allowWrite: true,
								acceptedReviewReasons:
									resolveGateDPreAuthorizedReviewReasons({ allowlist }),
								now: progressionNow,
							})
						},
					})
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'value-path-completed-at-backfill') {
	const allowWrite = args.includes('--allow-write')
	if (allowWrite && args.includes('--dry-run')) printUsageAndExit()
	const result = await backfillMissingValuePathCompletedAt({
		repository: await createCaptureRepository(),
		allowWrite,
	})
	const receiptPath =
		readFlag(args, '--receipt') ?? defaultCompletedAtBackfillReceiptPath(result)
	const absoluteReceiptPath = resolve(operatorWorkspaceRoot(), receiptPath)
	await mkdir(dirname(absoluteReceiptPath), { recursive: true })
	await writeFile(
		absoluteReceiptPath,
		`${JSON.stringify({ ...result, receiptPath }, null, 2)}\n`,
		'utf8',
	)
	console.log(JSON.stringify({ ...result, receiptPath }, null, 2))
} else if (command === 'learner-flow-stuck-list') {
	const result = await buildLearnerFlowStuckList()
	if (args.includes('--json')) {
		console.log(JSON.stringify(result, null, 2))
	} else {
		console.log(formatLearnerFlowStuckList(result))
	}
} else if (command === 'learner-flow-unstick') {
	const allowWrite = args.includes('--allow-write')
	if (allowWrite && args.includes('--dry-run')) printUsageAndExit()
	const result = await buildLearnerFlowUnstick({
		allowWrite,
		formId: Number(readFlag(args, '--signup-gap-form-id') ?? '9376133'),
	})
	if (args.includes('--json')) {
		console.log(JSON.stringify(result, null, 2))
	} else {
		console.log(formatLearnerFlowUnstick(result))
	}
} else if (command === 'learner-flow-report-publish') {
	const reportPath = readFlag(args, '--report')
	if (!reportPath) {
		printUsageAndExit()
	}
	const report = JSON.parse(await readFile(reportPath!, 'utf8')) as Record<
		string,
		unknown
	>
	if (!report || typeof report !== 'object' || Array.isArray(report)) {
		throw new Error('learner-flow report must be a JSON object')
	}
	const published = {
		schemaVersion: 'aih.learner-flow.published.v1' as const,
		publishedAt: new Date().toISOString(),
		report,
	}
	await redis.set(LEARNER_FLOW_REPORT_REDIS_KEY, published)
	const readback = await getLearnerFlowReport({ redis })
	const readbackMatches =
		JSON.stringify(readback) === JSON.stringify(report)
	if (!readbackMatches) {
		throw new Error('learner-flow report publish readback mismatch')
	}
	console.log(
		JSON.stringify(
			{
				mode: 'learner-flow-report-publish',
				key: LEARNER_FLOW_REPORT_REDIS_KEY,
				publishedAt: published.publishedAt,
				readbackMatches,
			},
			null,
			2,
		),
	)
} else if (command === 'value-path-intent-replan') {
	const contactIds = (readFlag(args, '--contact-ids') ?? '')
		.split(',')
		.map((id) => id.trim())
		.filter(Boolean)
	if (contactIds.length === 0) {
		printUsageAndExit()
	}
	const repository = await createCaptureRepository()
	const result = await replanBlockedValuePathEmailIntents({
		repository,
		contactIds,
		allowWrite: args.includes('--allow-write'),
	})
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'capture-front') {
	const repository = await createCaptureRepository()
	const result = await captureFrontQuickQuestion({
		repository,
		input: {
			conversationId: requireFlag(args, '--conversation-id'),
			messageId: readFlag(args, '--message-id'),
			messageCreatedAt:
				readFlag(args, '--message-created-at') ?? new Date().toISOString(),
			senderEmail: readFlag(args, '--sender-email'),
			senderName: readFlag(args, '--sender-name'),
			frontContactId: readFlag(args, '--front-contact-id'),
			text: await readCaptureText(args),
			isFollowUp: args.includes('--follow-up'),
			privacyLevel: args.includes('--restricted') ? 'restricted' : 'internal',
		},
	})
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'capture-front-csv') {
	const csvPath = requireFlag(args, '--quick-question-csv')
	const limit = readIntegerFlag(args, '--limit')
	const result = await captureFrontQuickQuestionCsv({
		repository: await createCaptureRepository(),
		csv: await readFile(csvPath, 'utf8'),
		dryRun: args.includes('--dry-run'),
		limit,
	})
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'purchase-preview') {
	const repository = await createPurchasePreviewRepository()
	const csvPath = readFlag(args, '--quick-question-csv')
	const analysisJsonPath = readFlag(args, '--quick-question-analysis-json')
	if (!csvPath && !analysisJsonPath) printUsageAndExit()
	const productIds = readAllFlags(args, '--product-id')
	const result = await previewPurchaseCorrelation({
		repository,
		quickQuestionCsv: csvPath ? await readFile(csvPath, 'utf8') : undefined,
		quickQuestionAnalysisJson: analysisJsonPath
			? await readFile(analysisJsonPath, 'utf8')
			: undefined,
		productIds: productIds.length ? productIds : ['product-9wdta'],
	})
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'matched-purchaser-value-path-preview') {
	const csvPath = requireFlag(args, '--quick-question-csv')
	const productIds = readAllFlags(args, '--product-id')
	const limit = readIntegerFlag(args, '--limit')
	const result = await previewMatchedPurchaserValuePaths({
		purchaseRepository: await createPurchasePreviewRepository(),
		lookupRepository: await createLookupRepository(),
		quickQuestionCsv: await readFile(csvPath, 'utf8'),
		productIds: productIds.length
			? productIds
			: ['product-9wdta', 'product-7t9ek'],
		limit,
	})
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'value-path-import-preview') {
	const allowWrite = args.includes('--allow-write')
	const dryRun = args.includes('--dry-run')
	if (allowWrite && dryRun) printUsageAndExit()
	const createdById = readFlag(args, '--created-by-id')
	if (allowWrite && !createdById) printUsageAndExit()
	const preview = previewValuePathContentImport({
		individualSequenceMdx: await readFile(
			requireFlag(args, '--individual-sequence-mdx'),
			'utf8',
		),
		teamSequenceMdx: await readFile(
			requireFlag(args, '--team-sequence-mdx'),
			'utf8',
		),
		individualAnswerPagesMdx: await readFile(
			requireFlag(args, '--individual-answer-pages-mdx'),
			'utf8',
		),
		teamAnswerPagesMdx: await readFile(
			requireFlag(args, '--team-answer-pages-mdx'),
			'utf8',
		),
	})
	const result = await importValuePathContentResources({
		database: allowWrite ? (await import('@/db')).db : undefined,
		preview,
		allowWrite,
		createdById,
	})
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'value-path-preview') {
	const contactId = requireFlag(args, '--contact-id')
	const result = await buildValuePathPreview(contactId)
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'value-path-qa-preview') {
	const individualSequenceMdx = await readFile(
		requireFlag(args, '--individual-sequence-mdx'),
		'utf8',
	)
	const teamSequenceMdx = await readFile(
		requireFlag(args, '--team-sequence-mdx'),
		'utf8',
	)
	const preview = previewValuePathContentImport({
		individualSequenceMdx,
		teamSequenceMdx,
		individualAnswerPagesMdx: await readFile(
			requireFlag(args, '--individual-answer-pages-mdx'),
			'utf8',
		),
		teamAnswerPagesMdx: await readFile(
			requireFlag(args, '--team-answer-pages-mdx'),
			'utf8',
		),
	})
	const teamShareLinkMapPath = readFlag(args, '--team-share-link-map-json')
	let teamShareLinkMap: ValuePathTeamShareLinkMap | undefined
	if (teamShareLinkMapPath) {
		try {
			teamShareLinkMap = JSON.parse(
				await readFile(teamShareLinkMapPath, 'utf8'),
			) as ValuePathTeamShareLinkMap
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			throw new Error(
				`Invalid JSON for --team-share-link-map-json ${teamShareLinkMapPath}: ${message}`,
			)
		}
	}
	const result = previewSkillsWorkflowValuePathQa({
		preview,
		individualSequenceMdx,
		teamSequenceMdx,
		teamShareLinkMap,
		baseUrl: readFlag(args, '--base-url'),
	})
	if (result.blockers.length > 0) {
		process.exitCode = 1
	}
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'value-path-gate-d-preview') {
	const result = await buildValuePathGateDPreview({
		kitFormId: readFlag(args, '--kit-form-id') ?? '9376133',
		recentDays: readIntegerFlag(args, '--recent-days') ?? 14,
		targetCount: readIntegerFlag(args, '--target-count') ?? 20,
		includeEmails: args.includes('--include-emails'),
		requireQuickQuestionReply:
			readFlag(args, '--require-quick-question-reply') === 'true',
		kitExportJsonPath: readFlag(args, '--kit-export-json'),
	})
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'value-path-gate-d-activate') {
	const dryRun = args.includes('--dry-run')
	const allowWrite = args.includes('--allow-write')
	if (dryRun === allowWrite) printUsageAndExit()
	const authorizationMode =
		readFlag(args, '--authorization-mode') ?? 'finish-approved-path'
	if (
		authorizationMode !== 'finish-approved-path' &&
		authorizationMode !== 'rolling-public-enrollment'
	) {
		throw new Error(
			'--authorization-mode must be finish-approved-path or rolling-public-enrollment',
		)
	}
	const result = await buildValuePathGateDActivation({
		candidatePreviewPath: requireFlag(args, '--candidate-preview'),
		activationId: requireFlag(args, '--activation-id'),
		approvedBy: readFlag(args, '--approved-by'),
		authorizationMode,
		allowWrite,
	})
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'value-path-gate-d-status') {
	const result = await buildValuePathGateDStatus()
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'value-path-completion-survey-sync') {
	const dryRun = args.includes('--dry-run')
	const allowWrite = args.includes('--allow-write')
	if (dryRun === allowWrite) printUsageAndExit()
	const result = await buildValuePathCompletionSurveySync({
		allowWrite,
		createdById:
			readFlag(args, '--created-by-id') ??
			'7febadb0-d116-4bb5-8495-1ef3f5e5c91b',
	})
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'value-path-contact-state-init') {
	const dryRun = args.includes('--dry-run')
	const allowWrite = args.includes('--allow-write')
	if (dryRun === allowWrite) printUsageAndExit()
	const result = await buildValuePathContactStateInit({ allowWrite })
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'value-path-gate-d-start') {
	const dryRun = args.includes('--dry-run')
	const allowWrite = args.includes('--allow-write')
	if (dryRun === allowWrite) printUsageAndExit()
	const result = await buildValuePathGateDStart({
		allowWrite,
		valuePathSlug: readFlag(args, '--path') ?? 'ai-hero-skills-workflow',
		emailResourceId:
			readFlag(args, '--email-resource-id') ??
			'ai-hero-skills-workflow.email-0',
		kitSequenceId: readFlag(args, '--kit-sequence-id') ?? '2757199',
		acceptedReviewReasons: readAllFlags(args, '--accept-review-reason'),
	})
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'value-path-drip-progress') {
	const dryRun = args.includes('--dry-run')
	const allowWrite = args.includes('--allow-write')
	if (dryRun === allowWrite) printUsageAndExit()
	const result = await buildValuePathDripProgress({
		allowWrite,
		limit: readIntegerFlag(args, '--limit') ?? 25,
		minAgeHours: readIntegerFlag(args, '--min-age-hours') ?? 18,
		acceptedReviewReasons: readAllFlags(args, '--accept-review-reason'),
	})
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'value-path-email-executor') {
	if (!args.includes('--allow-write')) printUsageAndExit()
	const mode = parseExecutorMode(readFlag(args, '--mode'))
	if (mode !== 'allowlisted-test' && !args.includes('--allow-scoped-live')) {
		printUsageAndExit()
	}
	const { emailListProvider } =
		await import('@/coursebuilder/email-list-provider')
	const runtimeAllowlist = args.includes('--use-gate-d-allowlist')
		? await requireActiveGateDAllowlist()
		: undefined
	const acceptedReviewReasons = resolveGateDPreAuthorizedReviewReasons({
		allowlist: runtimeAllowlist,
		explicitReviewReasons: readAllFlags(args, '--accept-review-reason'),
		legacyEnvReviewReasons: parseExecutorList(
			process.env.AIH_VALUE_PATH_ACCEPTED_REVIEW_REASONS,
		),
	})
	const requestedIntentIds = readAllFlags(args, '--intent-id')
	const result = await executePendingValuePathEmailIntents({
		repository: await createCaptureRepository(),
		emailListProvider,
		config: {
			mode,
			limit:
				readIntegerFlag(args, '--limit') ??
				runtimeAllowlist?.maxSendsPerRun ??
				25,
			baseUrl:
				readFlag(args, '--base-url') ??
				process.env.NEXT_PUBLIC_URL ??
				process.env.NEXT_PUBLIC_SITE_URL ??
				'https://www.aihero.dev',
			pathTokenSecret: process.env.AI_HERO_VALUE_PATH_TOKEN_SECRET,
			answerPages: await getValuePathAnswerPages(),
			allowlistedContactIds: [
				...readAllFlags(args, '--allowlisted-contact-id'),
				...(runtimeAllowlist?.contactIds ?? []),
			],
			allowlistedKitSubscriberIds: [
				...readAllFlags(args, '--allowlisted-kit-subscriber-id'),
				...(runtimeAllowlist?.kitSubscriberIds ?? []),
			],
			allowlistedEmails: [
				...readAllFlags(args, '--allowlisted-email'),
				...(runtimeAllowlist?.emails ?? []),
			],
			enabledValuePathSlugs: [
				...parseExecutorList(readFlag(args, '--enabled-value-path-slugs')),
				...(runtimeAllowlist?.pathSlugs ?? []),
			],
			verifiedEmailResourceIds: [
				...parseExecutorList(readFlag(args, '--verified-email-resource-ids')),
				...(runtimeAllowlist?.emailResourceIds ?? []),
			],
			verifiedKitSequenceIds: [
				...parseExecutorList(readFlag(args, '--verified-kit-sequence-ids')),
				...(runtimeAllowlist?.kitSequenceIds ?? []),
			],
			allowedActions: runtimeAllowlist?.allowedActions,
			retryPolicy: runtimeAllowlist?.retryPolicy,
			providerPacingMs: readIntegerFlag(args, '--provider-pacing-ms') ?? 1500,
			acceptedReviewReasons,
			intentIds:
				requestedIntentIds.length > 0 ? requestedIntentIds : undefined,
		},
	})
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'shadow-field-preview') {
	const contactId = requireFlag(args, '--contact-id')
	const { snapshot, valuePath } = await buildSnapshotAndValuePath(contactId)
	const result = previewShadowFieldsForContactSnapshot({
		snapshot,
		valuePathCandidate: valuePath.candidate,
	})
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'shadow-field-sync') {
	const contactId = requireFlag(args, '--contact-id')
	const dryRun = args.includes('--dry-run')
	const allowWrite = args.includes('--allow-write')
	if (dryRun === allowWrite) printUsageAndExit()
	const acceptedReviewReasons = readAllFlags(args, '--accept-review-reason')
	const { snapshot, valuePath } = await buildSnapshotAndValuePath(contactId)
	const { emailListProvider } =
		await import('@/coursebuilder/email-list-provider')
	const result = await syncShadowFieldsForContactSnapshot({
		snapshot,
		valuePathCandidate: valuePath.candidate,
		provider: emailListProvider,
		allowWrite,
		acceptedReviewReasons,
	})
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'team-kit-projection') {
	const dryRun = args.includes('--dry-run')
	const allowWrite = args.includes('--allow-write')
	if (dryRun === allowWrite) printUsageAndExit()
	const limit = readIntegerFlag(args, '--limit')
	const skipKitLookup = args.includes('--skip-kit-lookup')
	if (allowWrite && skipKitLookup) printUsageAndExit()
	const { db } = await import('@/db')
	const provider = skipKitLookup
		? undefined
		: (await import('@/coursebuilder/email-list-provider')).emailListProvider
	const result = await previewTeamKitProjection({
		database: db,
		provider,
		allowWrite,
		limit,
		offset: readOffsetFlag(args, '--offset'),
		kitLookupDelayMs: readIntegerFlag(args, '--kit-lookup-delay-ms'),
		kitLookupMaxAttempts: readIntegerFlag(args, '--kit-lookup-max-attempts'),
		ownerTagId: readFlag(args, '--owner-tag-id'),
		memberTagId: readFlag(args, '--member-tag-id'),
	})
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'seen-content-preview') {
	const contactId = requireFlag(args, '--contact-id')
	const limit = readIntegerFlag(args, '--limit') ?? 100
	const result = await buildSeenContentPreview({ contactId, limit })
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'seen-content-kit-sync') {
	const contactId = requireFlag(args, '--contact-id')
	const dryRun = args.includes('--dry-run')
	const allowWrite = args.includes('--allow-write')
	if (dryRun === allowWrite) printUsageAndExit()
	const snapshot = await buildContactSnapshot(
		contactId,
		readIntegerFlag(args, '--limit') ?? 100,
	)
	const { emailListProvider } =
		await import('@/coursebuilder/email-list-provider')
	const result = await syncSeenContentKitFieldsForContactSnapshot({
		snapshot,
		provider: emailListProvider,
		allowWrite,
	})
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'content-read-event-preview') {
	const limitProvided = args.includes('--limit')
	const limit = readIntegerFlag(args, '--limit') ?? 100
	const sampleLimit = readIntegerFlag(args, '--sample-limit') ?? 10
	const allowWrite = args.includes('--allow-write')
	validateContentReadAllowWriteOptions({
		allowWrite,
		limit,
		limitProvided,
		forceLargeWrite: args.includes('--force-large-write'),
	})
	const result = await buildContentReadEventPreview({
		limit,
		sampleLimit,
		allowWrite,
	})
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'content-read-event-review-page') {
	const limit = readIntegerFlag(args, '--limit') ?? 100
	const sampleLimit = readIntegerFlag(args, '--sample-limit') ?? 10
	const preview = await buildContentReadEventPreview({
		limit,
		sampleLimit,
		allowWrite: false,
	})
	if (preview.mode !== 'dry-run') throw new Error('Expected dry-run preview')
	const html = renderContactEventReviewHtml({
		title: 'AIH-133 Content Read Review',
		sourceTable: 'AI_ContentRead',
		preview,
		nextWriteCommand:
			'pnpm subscriber-marketing:operator content-read-event-preview --allow-write --limit 5 --sample-limit 5',
	})
	console.log(html)
} else if (command === 'aih-133-production-receipt') {
	const limit = readIntegerFlag(args, '--limit') ?? 100
	const preview = await buildContentReadEventPreview({
		limit,
		sampleLimit: 10,
		allowWrite: false,
	})
	if (preview.mode !== 'dry-run') throw new Error('Expected dry-run preview')
	const retention = await buildContentReadRetention({
		allowWrite: false,
	})
	const result = buildContactEventProductionReceipt({
		preview,
		retention: {
			retentionDays: retention.retentionDays,
			cutoff: retention.cutoff,
			candidateCount: retention.candidateCount,
		},
	})
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'shortlink-click-event-preview') {
	const limit = readIntegerFlag(args, '--limit') ?? 100
	const sampleLimit = readIntegerFlag(args, '--sample-limit') ?? 10
	const result = await buildShortlinkClickEventPreview({ limit, sampleLimit })
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'content-read-retention') {
	const retentionDays = readIntegerFlag(args, '--retention-days')
	const allowWrite = args.includes('--allow-write')
	const result = await buildContentReadRetention({ retentionDays, allowWrite })
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'link-kit-subscriber-identities') {
	const limit = readIntegerFlag(args, '--limit') ?? 25
	const candidatePreviewPath = readFlag(args, '--candidate-preview')
	const dryRun = args.includes('--dry-run')
	const allowWrite = args.includes('--allow-write')
	if (dryRun === allowWrite) printUsageAndExit()
	const result = candidatePreviewPath
		? await buildKitSubscriberIdentityLinksFromPreview({
				candidatePreviewPath,
				allowWrite,
			})
		: allowWrite
			? await buildKitSubscriberIdentityLinks({ limit })
			: await buildKitSubscriberIdentityLinksDryRun({ limit })
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'link-ai-hero-user-identities') {
	const limit = readIntegerFlag(args, '--limit') ?? 25
	const allowWrite = args.includes('--allow-write')
	if (!allowWrite) printUsageAndExit()
	const result = await buildAiHeroUserIdentityLinks({ limit })
	console.log(JSON.stringify(result, null, 2))
} else if (command === 'shadow-field-candidates') {
	const limit = readIntegerFlag(args, '--limit') ?? 50
	const scanLimit =
		readIntegerFlag(args, '--scan-limit') ?? Math.max(limit * 5, 100)
	const status = readFlag(args, '--status')
	const candidateStatus = status
		? parseShadowFieldCandidateStatus(status)
		: undefined
	const result = await buildShadowFieldCandidates({
		limit,
		scanLimit,
		status: candidateStatus,
		noReviewReasons: args.includes('--no-review-reasons'),
	})
	console.log(JSON.stringify(result, null, 2))
} else {
	printUsageAndExit()
}

async function buildLearnerFlowStuckList() {
	const generatedAt = new Date().toISOString()
	const records =
		await (await createCaptureRepository()).findSkillsWorkflowLearnerFlowRecords()
	const learners = records.map((record) => {
		const classification = classifyLearnerFlowContact({
			contactId: record.contactId,
			contact: record.contact,
			contactState: record.contactState,
			intents: record.intents,
			entryEvents: record.entryEvents,
			now: generatedAt,
		})
		return {
			contactId: record.contactId,
			maskedEmail: maskLearnerFlowEmail(record.contact?.email),
			...classification,
		}
	})
	const stateCounts = {
		moving: learners.filter((learner) => learner.state === 'moving').length,
		terminal: learners.filter((learner) => learner.state === 'terminal').length,
		stuck: learners.filter((learner) => learner.state === 'stuck').length,
	}
	const causeCounts = learners.reduce<Record<LearnerFlowStuckCause, number>>(
		(counts, learner) => {
			if (learner.cause) counts[learner.cause] = (counts[learner.cause] ?? 0) + 1
			return counts
		},
		{} as Record<LearnerFlowStuckCause, number>,
	)
	const accounted = stateCounts.moving + stateCounts.terminal + stateCounts.stuck
	return {
		mode: 'read-only' as const,
		writes: {
			database: false,
			provider: false,
		},
		generatedAt,
		counts: {
			total: learners.length,
			...stateCounts,
			accounted,
		},
		causeCounts,
		assertion: {
			passed: accounted === learners.length,
			expression: 'moving + terminal + stuck = total contacts on course paths',
		},
		stuck: learners.filter((learner) => learner.state === 'stuck'),
	}
}

function formatLearnerFlowStuckList(
	result: Awaited<ReturnType<typeof buildLearnerFlowStuckList>>,
) {
	const lines = [
		'Learner flow stuck list (read-only)',
		`Generated: ${result.generatedAt}`,
		`Counts: total=${result.counts.total} moving=${result.counts.moving} terminal=${result.counts.terminal} stuck=${result.counts.stuck}`,
		`Accountability: ${result.assertion.passed ? 'PASS' : 'FAIL'} (${result.counts.accounted} = ${result.counts.total}; ${result.assertion.expression})`,
	]
	if (result.stuck.length === 0) {
		lines.push('Stuck learners: none')
		return lines.join('\n')
	}
	lines.push('Stuck learners:')
	for (const learner of result.stuck) {
		lines.push(
			`- ${learner.maskedEmail} | ${learner.contactId} | ${learner.stage} | ${learner.stuckAgeHours ?? 'unknown'}h | ${learner.cause}\n  ${learner.unstickCommand}`,
		)
	}
	return lines.join('\n')
}

async function buildLearnerFlowUnstick(args: {
	allowWrite: boolean
	formId: number
}) {
	if (!Number.isInteger(args.formId) || args.formId <= 0) {
		throw new Error('--signup-gap-form-id must be a positive integer')
	}
	const generatedAt = new Date().toISOString()
	const stuckList = await buildLearnerFlowStuckList()
	const partition = partitionLearnerFlowUnstickItems(
		stuckList.stuck.flatMap((learner) =>
			learner.cause
				? [{
					contactId: learner.contactId,
					intentId: learner.intentId,
					stage: learner.stage,
					stuckAgeHours: learner.stuckAgeHours,
					cause: learner.cause,
					unstickCommand: learner.unstickCommand,
				}]
				: [],
		),
	)
	const blockedItems = partition.tier1.filter(
		(item) => item.action === 'replan-blocked-intent' && item.intentId,
	)
	const blockedContactIds = blockedItems.map((item) => item.contactId)
	const blockedIntentIds = blockedItems.flatMap((item) =>
		item.intentId ? [item.intentId] : [],
	)
	const retryIntentIds = partition.tier1
		.filter((item) => item.action === 'retry-transient-failure')
		.flatMap((item) => (item.intentId ? [item.intentId] : []))
	const dripItems = partition.tier1.filter(
		(item) => item.action === 'nudge-drip-progression' && item.intentId,
	)
	const dripContactIds = dripItems.map((item) => item.contactId)
	const dripIntentIds = new Set(
		dripItems.flatMap((item) => (item.intentId ? [item.intentId] : [])),
	)
	const signupGapWindow = {
		from: new Date(Date.parse(generatedAt) - 47 * 60 * 60 * 1000).toISOString(),
		to: generatedAt,
	}
	const signupGapCheck = await checkLearnerFlowSignupGap(() =>
		buildSignupGapOperatorPreview({
			formId: args.formId,
			...signupGapWindow,
		}),
	)
	const signupGapPreview =
		signupGapCheck.status === 'available' ? signupGapCheck.preview : undefined
	const signupGapUnavailable =
		signupGapCheck.status === 'source-unavailable'
			? signupGapCheck
			: undefined
	const signupGapEligible = Boolean(
		signupGapPreview &&
			signupGapPreview.counts.replayable > 0 &&
			isTier1SignupGapReplay({
				candidateCount: signupGapPreview.counts.replayable,
				candidateCreatedAt: signupGapPreview.candidates
					.filter((candidate) => !candidate.excludedSynthetic)
					.map((candidate) => candidate.createdAt),
				now: generatedAt,
			}),
	)
	const requiresGateD = retryIntentIds.length > 0 || dripContactIds.length > 0
	// Reading the active authorization is safe and required for an honest
	// dry-run. The old allow-write guard made every drip recovery preview report
	// planned: 0 without actually invoking the planner.
	const allowlist = requiresGateD ? await requireActiveGateDAllowlist() : undefined
	const repository = await createCaptureRepository()
	const replan = blockedIntentIds.length
		? await replanBlockedValuePathEmailIntents({
			repository,
			contactIds: blockedContactIds,
			intentIds: blockedIntentIds,
			allowWrite: args.allowWrite,
			now: generatedAt,
		})
		: undefined
	const retryLimit = allowlist?.maxSendsPerRun ?? 25
	const retryableIntentIds = retryIntentIds.slice(0, retryLimit)
	const retryResults =
		allowlist && retryableIntentIds.length > 0
			? await executePendingValuePathEmailIntents({
				repository,
				emailListProvider: (await import('@/coursebuilder/email-list-provider'))
					.emailListProvider,
				now: generatedAt,
				config: {
					mode: allowlist.mode,
					limit: retryableIntentIds.length,
					allowWrite: args.allowWrite,
					intentIds: retryableIntentIds,
					baseUrl:
						process.env.NEXT_PUBLIC_URL ??
						process.env.NEXT_PUBLIC_SITE_URL ??
						'https://www.aihero.dev',
					pathTokenSecret: process.env.AI_HERO_VALUE_PATH_TOKEN_SECRET,
					answerPages: await getValuePathAnswerPages(),
					allowlistedContactIds: allowlist.contactIds,
					allowlistedKitSubscriberIds: allowlist.kitSubscriberIds,
					allowlistedEmails: allowlist.emails,
					enabledValuePathSlugs: allowlist.pathSlugs,
					verifiedEmailResourceIds: allowlist.emailResourceIds,
					verifiedKitSequenceIds: allowlist.kitSequenceIds,
					allowedActions: allowlist.allowedActions,
					retryPolicy: allowlist.retryPolicy,
				},
			})
			: []
	const completedIntents = (
		await Promise.all(
			dripContactIds.map((contactId) =>
				repository.findValuePathEmailSideEffectIntentsByContact(contactId),
			),
		)
	).flatMap((intents) =>
		intents.filter(
			(intent) =>
				isValuePathIntentCompleted(intent) && dripIntentIds.has(intent.id),
		),
	)
	const drip =
		allowlist && completedIntents.length > 0
			? await progressValuePathDrips({
				repository,
				allowlist,
				completedIntents,
				allowWrite: args.allowWrite,
				now: generatedAt,
			})
			: undefined
	const signupGapReplay =
		args.allowWrite && signupGapEligible && signupGapPreview
			? await replaySignupGap({
					preview: signupGapPreview,
					source: 'learner-flow-unstick',
					hasExistingIdentity: async (candidate) =>
						Boolean(
							(await repository.findContactByEmail(candidate.email)) ??
								(await repository.findProviderIdentity(
									'kit',
									candidate.kitSubscriberId,
								)),
						),
					emit: async (event) =>
					(await import('@/inngest/inngest.server')).inngest.send(event),
				})
			: undefined
	const tier2Ask = [
		...partition.tier2.map((item) => ({
			contactId: item.contactId,
			stage: item.stage,
			stuckAgeHours: item.stuckAgeHours,
			cause: item.cause,
			proposedCommand: item.unstickCommand,
		})),
		...(signupGapPreview &&
		signupGapPreview.counts.replayable > 0 &&
		!signupGapEligible
			? [{
				contactId: 'signup-gap-batch',
				stage: 'signup-recovery',
				stuckAgeHours: undefined,
				cause: 'signup-gap-exceeds-tier-1-bound',
				proposedCommand: `tier-2: ask Joel (replay ${signupGapPreview.counts.replayable} fresh signup gaps; tier-1 maximum is 25)`,
			}]
			: []),
	]
	return {
		mode: 'learner-flow-unstick',
		allowWrite: args.allowWrite,
		generatedAt,
		writes: {
			database: Boolean(
				args.allowWrite &&
					(replan?.counts.replanned ||
						retryResults.length ||
						(drip?.counts.planned ?? 0) > 0),
			),
			provider: Boolean(args.allowWrite && (retryResults.length || signupGapReplay)),
		},
		counts: stuckList.counts,
		causeCounts: stuckList.causeCounts,
		tiers: {
			tier1: {
				stuckItems: partition.tier1.length,
				replan: replan?.counts ?? { contacts: 0, blockedIntentsFound: 0, replanned: 0, wouldReplan: 0 },
				retry: {
					eligible: retryIntentIds.length,
					previewed: args.allowWrite ? 0 : retryResults.length,
					planned: retryResults.filter((result) => result.status === 'planned')
						.length,
					executed: args.allowWrite ? retryResults.length : 0,
					completed: retryResults.filter(
						(result) => result.status === 'completed',
					).length,
					deferred: retryIntentIds.length - retryableIntentIds.length,
					results: retryResults.map((result) => ({
						intentId: result.intentId,
						status: result.status,
						...('reviewReasons' in result
							? { reviewReasons: result.reviewReasons }
							: {}),
					})),
				},
				drip: {
					contactCount: dripContactIds.length,
					uniqueContactCount: new Set(dripContactIds).size,
					duplicateContactCount:
						dripContactIds.length - new Set(dripContactIds).size,
					...(drip?.counts ?? { planned: 0 }),
				},
				signupGap:
					signupGapPreview
						? {
							status: 'available' as const,
							formId: args.formId,
							window: signupGapPreview.window,
							replayable: signupGapPreview.counts.replayable,
							eligible: signupGapEligible,
							emitted: signupGapReplay?.counts.emitted ?? 0,
						}
						: {
							status: 'source-unavailable' as const,
							formId: args.formId,
							window: signupGapWindow,
							replayable: 0,
							eligible: false,
							emitted: 0,
							source: signupGapUnavailable?.source ?? 'kit',
							attempts: signupGapUnavailable?.attempts ?? 0,
							statusCode: signupGapUnavailable?.statusCode,
							message:
								signupGapUnavailable?.message ??
								'Kit signup-gap source unavailable',
						},
			},
				tier2: { ask: tier2Ask },
			tier3: { actionCount: 0 },
		},
	}
}

function formatLearnerFlowUnstick(
	result: Awaited<ReturnType<typeof buildLearnerFlowUnstick>>,
) {
	const lines = [
		`Learner flow unstick (${result.allowWrite ? 'allow-write' : 'dry-run'})`,
		`Generated: ${result.generatedAt}`,
		`Counts: total=${result.counts.total} moving=${result.counts.moving} terminal=${result.counts.terminal} stuck=${result.counts.stuck}`,
		`Tier 1 auto: stuck=${result.tiers.tier1.stuckItems} replanned=${result.tiers.tier1.replan.replanned} would-replan=${result.tiers.tier1.replan.wouldReplan} retry-previewed=${result.tiers.tier1.retry.previewed} retry-planned=${result.tiers.tier1.retry.planned} retry-completed=${result.tiers.tier1.retry.completed}/${result.tiers.tier1.retry.eligible} drip-planned=${result.tiers.tier1.drip.planned} signup-gap-status=${result.tiers.tier1.signupGap.status} signup-gap-replayable=${result.tiers.tier1.signupGap.replayable} signup-gap-emitted=${result.tiers.tier1.signupGap.emitted}`,
		`Tier 2 ask Joel: ${result.tiers.tier2.ask.length}`,
	]
	for (const item of result.tiers.tier2.ask) {
		lines.push(
			`- ${item.contactId} | ${item.stage} | ${item.stuckAgeHours ?? 'unknown'}h | ${item.cause}\n  ${item.proposedCommand ?? 'ask Joel'}`,
		)
	}
	lines.push('Tier 3 never: 0 actions (not representable)')
	return lines.join('\n')
}

function maskLearnerFlowEmail(value?: string | null) {
	const normalized = normalizeEmail(value)
	if (!normalized) return '<missing-email>'
	const [local, domain] = normalized.split('@')
	if (!local || !domain) return '<invalid-email>'
	return `${local.slice(0, 1)}***@${domain}`
}

function parseLookupInput(args: string[]): OperatorLookupInput {
	const email = readFlag(args, '--email')
	if (email) return { type: 'email', email }

	const contactId = readFlag(args, '--contact-id')
	if (contactId) return { type: 'contact-id', contactId }

	const userId = readFlag(args, '--user-id')
	if (userId) return { type: 'user-id', userId }

	const provider = readFlag(args, '--provider')
	const externalId = readFlag(args, '--external-id')
	if (provider && externalId) {
		if (!isProvider(provider)) printUsageAndExit()
		return {
			type: 'provider-identity',
			provider,
			externalId,
		}
	}

	printUsageAndExit()
}

async function buildValuePathGateDPreview(args: {
	kitFormId: string
	recentDays: number
	targetCount: number
	includeEmails: boolean
	requireQuickQuestionReply: boolean
	kitExportJsonPath?: string
}) {
	const skillsFormSubscribers = args.kitExportJsonPath
		? parseKitFormSubscribersExport(
				await readFile(args.kitExportJsonPath, 'utf8'),
			)
		: await fetchKitFormSubscribers({
				formId: args.kitFormId,
				recentDays: args.recentDays,
			})
	const [quickQuestionReplies, contactMatches] = await Promise.all([
		fetchRecentQuickQuestionReplies({
			recentDays: args.recentDays,
		}),
		fetchContactMatchesForSkillsSubscribers(skillsFormSubscribers),
	])
	return previewValuePathGateDCandidates({
		skillsFormSubscribers,
		quickQuestionReplies,
		contactMatches,
		requireQuickQuestionReply: args.requireQuickQuestionReply,
		recentDays: args.recentDays,
		targetCount: args.targetCount,
		includeEmails: args.includeEmails,
	})
}

async function buildValuePathGateDActivation(args: {
	candidatePreviewPath: string
	activationId: string
	approvedBy?: string
	authorizationMode: GateDAuthorizationMode
	allowWrite: boolean
}) {
	const preview = JSON.parse(
		await readFile(args.candidatePreviewPath, 'utf8'),
	) as GateDCandidatePreview
	const now = new Date().toISOString()
	const candidates = preview.candidates.filter(
		(candidate) => candidate.contactId && candidate.blockers.length === 0,
	)
	const allowlist = normalizeGateDRuntimeAllowlist({
		activationId: args.activationId,
		name: `Skills Workflow pilot ${args.activationId}`,
		status: 'active',
		killSwitch: false,
		// Rolling enrollment admits contacts that are not on the candidate list,
		// so the send gate must run scoped-live; allowlisted-test blocks any
		// contact outside the carried cohort.
		mode:
			args.authorizationMode === 'rolling-public-enrollment'
				? 'scoped-live'
				: 'allowlisted-test',
		authorizationMode: args.authorizationMode,
		pathSlugs: SKILLS_WORKFLOW_PATH_SLUGS,
		contactIds: candidates.map((candidate) => candidate.contactId!),
		kitSubscriberIds: candidates
			.map((candidate) => candidate.kitSubscriberId)
			.filter((id): id is string => Boolean(id)),
		emails: candidates
			.map((candidate) => candidate.email)
			.filter((email): email is string => Boolean(email)),
		emailHashes: candidates
			.map((candidate) => candidate.emailHash)
			.filter((hash): hash is string => Boolean(hash)),
		emailResourceIds: SKILLS_WORKFLOW_EMAIL_RESOURCE_IDS,
		kitSequenceIds: SKILLS_WORKFLOW_KIT_SEQUENCE_IDS,
		candidates: candidates.map(candidatePreviewToAllowlistCandidate),
		allowedActions: [...DEFAULT_GATE_D_ALLOWED_ACTIONS],
		preAuthorizedReviewReasons: [
			...DEFAULT_GATE_D_PREAUTHORIZED_REVIEW_REASONS,
		],
		stopFor: [...DEFAULT_GATE_D_STOP_REASONS],
		retryPolicy: DEFAULT_GATE_D_RETRY_POLICY,
		maxSendsPerRun: DEFAULT_GATE_D_MAX_SENDS_PER_RUN,
		approvedBy: args.approvedBy,
		approvedAt: now,
		createdAt: now,
		updatedAt: now,
	})
	if (args.allowWrite) {
		await writeGateDRuntimeAllowlist({
			redis,
			allowlist,
			activate: true,
		})
	}
	return {
		mode: args.allowWrite ? 'allow-write' : 'dry-run',
		activationId: args.activationId,
		keys: {
			activePointer: gateDActivePointerKey(),
			activationObject: gateDActivationObjectKey(args.activationId),
		},
		counts: {
			approvedCandidates: candidates.length,
			contactIds: allowlist.contactIds.length,
			kitSubscriberIds: allowlist.kitSubscriberIds.length,
			emails: allowlist.emails.length,
			emailHashes: allowlist.emailHashes.length,
		},
		redisObject: redactAllowlistForOutput(allowlist),
		wroteRedis: args.allowWrite,
		customerVisibleSends: false,
	}
}

async function buildValuePathCompletionSurveySync(args: {
	allowWrite: boolean
	createdById: string
}) {
	const existingSurvey = await db.query.contentResource.findFirst({
		where: eq(contentResource.id, VALUE_PATH_COMPLETION_SURVEY_SPEC.survey.id),
		with: {
			resources: {
				with: { resource: true },
				orderBy: (table, { asc }) => [asc(table.position)],
			},
		},
	})
	const existingQuestions = await db.query.contentResource.findMany({
		where: inArray(
			contentResource.id,
			VALUE_PATH_COMPLETION_SURVEY_SPEC.questions.map(
				(question) => question.id,
			),
		),
	})
	const existingRelations = await db.query.contentResourceResource.findMany({
		where: eq(
			contentResourceResource.resourceOfId,
			VALUE_PATH_COMPLETION_SURVEY_SPEC.survey.id,
		),
	})

	const actions = [
		{
			type: existingSurvey ? 'update-survey' : 'create-survey',
			id: VALUE_PATH_COMPLETION_SURVEY_SPEC.survey.id,
		},
		...VALUE_PATH_COMPLETION_SURVEY_SPEC.questions.map((question) => ({
			type: existingQuestions.some((existing) => existing.id === question.id)
				? 'update-question'
				: 'create-question',
			id: question.id,
			slug: question.fields.slug,
		})),
		...VALUE_PATH_COMPLETION_SURVEY_SPEC.questions.map((question) => ({
			type: existingRelations.some(
				(relation) => relation.resourceId === question.id,
			)
				? 'update-relation'
				: 'create-relation',
			id: `${VALUE_PATH_COMPLETION_SURVEY_SPEC.survey.id}:${question.id}`,
			position: question.position,
		})),
	]

	if (args.allowWrite) {
		await db.transaction(async (tx) => {
			await tx
				.insert(contentResource)
				.values({
					id: VALUE_PATH_COMPLETION_SURVEY_SPEC.survey.id,
					type: VALUE_PATH_COMPLETION_SURVEY_SPEC.survey.type,
					createdById: args.createdById,
					fields: VALUE_PATH_COMPLETION_SURVEY_SPEC.survey.fields,
				})
				.onDuplicateKeyUpdate({
					set: { fields: VALUE_PATH_COMPLETION_SURVEY_SPEC.survey.fields },
				})

			for (const question of VALUE_PATH_COMPLETION_SURVEY_SPEC.questions) {
				await tx
					.insert(contentResource)
					.values({
						id: question.id,
						type: 'question',
						createdById: args.createdById,
						fields: question.fields,
					})
					.onDuplicateKeyUpdate({ set: { fields: question.fields } })

				const existingRelation = existingRelations.find(
					(relation) => relation.resourceId === question.id,
				)
				if (existingRelation) {
					await tx
						.update(contentResourceResource)
						.set({ position: question.position })
						.where(
							and(
								eq(
									contentResourceResource.resourceOfId,
									VALUE_PATH_COMPLETION_SURVEY_SPEC.survey.id,
								),
								eq(contentResourceResource.resourceId, question.id),
							),
						)
				} else {
					await tx.insert(contentResourceResource).values({
						resourceOfId: VALUE_PATH_COMPLETION_SURVEY_SPEC.survey.id,
						resourceId: question.id,
						position: question.position,
					})
				}
			}
		})
	}

	return {
		mode: args.allowWrite ? 'allow-write' : 'dry-run',
		survey: VALUE_PATH_COMPLETION_SURVEY_SPEC.survey,
		questions: VALUE_PATH_COMPLETION_SURVEY_SPEC.questions.map((question) => ({
			id: question.id,
			position: question.position,
			fields: question.fields,
		})),
		actions,
		wroteDatabase: args.allowWrite,
		customerVisibleSends: false,
		kitWrites: false,
	}
}

async function buildValuePathGateDStatus() {
	const checkedAt = new Date().toISOString()
	const allowlistDecision = await readActiveGateDRuntimeAllowlist({ redis })
	const allowlist = allowlistDecision.allowlist
		? normalizeGateDRuntimeAllowlist(allowlistDecision.allowlist)
		: undefined
	const activationContactIds = allowlist?.contactIds ?? []
	const repository = await createCaptureRepository()
	const cohort = allowlist
		? await queryLearnerFlowCohort({ repository, allowlist })
		: undefined
	const contactIds = cohort?.contactIds ?? []
	const [intents, events] = contactIds.length
		? await Promise.all([
				db
					.select()
					.from(sideEffectIntent)
					.where(
						and(
							inArray(sideEffectIntent.contactId, contactIds),
							eq(sideEffectIntent.type, 'send-value-path-email'),
						),
					),
				db
					.select()
					.from(contactEvent)
					.where(inArray(contactEvent.contactId, contactIds)),
			])
		: [[], []]
	const byContact = contactIds.map((contactId) => {
		const contactIntents = intents
			.filter((intent) => intent.contactId === contactId)
			.sort((a, b) => Number(a.createdAt) - Number(b.createdAt))
		const contactEvents = events
			.filter((event) => event.contactId === contactId)
			.sort((a, b) => Number(a.occurredAt) - Number(b.occurredAt))
		const answerClicks = contactEvents.filter(
			(event) => event.eventType === 'value-path.answer-selected',
		)
		const drips = contactEvents.filter(
			(event) => event.eventType === 'value-path.drip-progressed',
		)
		const blocked = contactIntents.filter(
			(intent) => intent.status === 'blocked',
		)
		const lastIntent = contactIntents[contactIntents.length - 1]
		const completedPath = contactIntents.some(
			(intent) =>
				isValuePathIntentCompleted(intent) &&
				isTerminalValuePathEmailResourceId(
					String(intent.metadata?.emailResourceId ?? ''),
				),
		)
		return {
			contactId,
			completedPath,
			lastEmailResourceId: lastIntent?.metadata?.emailResourceId,
			lastKitSequenceId: lastIntent?.metadata?.kitSequenceId,
			lastStatus: lastIntent?.status,
			answerClicks: answerClicks.length,
			drips: drips.length,
			blocked: blocked.map((intent) => ({
				intentId: intent.id,
				emailResourceId: intent.metadata?.emailResourceId,
				kitSequenceId: intent.metadata?.kitSequenceId,
				reviewReasons: intent.reviewReasons,
			})),
		}
	})
	const grouped: Record<string, number> = {}
	for (const intent of intents) {
		const completionStatus = isValuePathIntentCompleted(intent)
			? 'completed'
			: intent.status
		const key = `${completionStatus}:${intent.metadata?.emailResourceId}:${intent.metadata?.kitSequenceId}`
		grouped[key] = (grouped[key] ?? 0) + 1
	}
	const eventTypes: Record<string, number> = {}
	for (const event of events) {
		eventTypes[event.eventType] = (eventTypes[event.eventType] ?? 0) + 1
	}
	const computedDrip = allowlist && cohort
		? await buildComputedGateDDripStatus(allowlist, cohort)
		: null
	const retrying = summarizeRetryingValuePathIntents(
		intents.filter((intent) => !isValuePathIntentCompleted(intent)),
		checkedAt,
	)
	const currentStepDistribution = countByValues(
		byContact.map((contact) => String(contact.lastEmailResourceId ?? 'none')),
	)
	const completedPathCount = byContact.filter(
		(contact) => contact.completedPath,
	).length
	const persistedBlockedReasons = countReviewReasons(
		intents.filter((intent) => intent.status === 'blocked'),
	)
	const hardBlockers = mergeReasonCounts(
		persistedBlockedReasons,
		computedDrip?.blockedReasons ?? {},
		retrying.hardFailedReasons,
	)
	const hiddenConfigBlockers = pickReasonCounts(hardBlockers, [
		'path-token-secret-missing',
		'value-path-base-url-missing',
		'answer-pages-missing',
		'email-resource-missing',
		'kit-sequence-missing',
		'value-path-step-missing',
	])
	const movement = evaluateValuePathMovement({
		intents: intents.map((intent) => ({
			createdAt: intent.createdAt,
			completedAt: intent.completedAt,
			metadata: intent.metadata ?? undefined,
		})),
		events: events.map((event) => ({
			eventType: event.eventType,
			occurredAt: event.occurredAt,
		})),
		participants: contactIds.length,
		completedPathCount,
		now: checkedAt,
	})
	const runState = resolveGateDRunState({
		authorizationPassed: allowlistDecision.passed,
		authorizationReviewReasons: allowlistDecision.reviewReasons,
		hardBlockerCount: Object.keys(hardBlockers).length,
		retryableDue: retrying.retryableDue,
		retryableWaiting: retrying.retryableWaiting,
		nextRetryAt: retrying.nextRetryAt,
		pending: intents.filter(
			(intent) =>
				intent.status === 'pending' && !isValuePathIntentCompleted(intent),
		).length,
		dueSends: computedDrip?.counts.planned ?? 0,
		participants: contactIds.length,
		completedPathCount,
		movement,
	})
	return {
		checkedAt,
		reportingCohort: {
			source: cohort?.source ?? 'unavailable',
			contacts: contactIds.length,
			liveRecordsScanned: cohort?.liveRecordsScanned ?? 0,
			activationSnapshotContacts: activationContactIds.length,
		},
		allowlist: {
			passed: allowlistDecision.passed,
			reviewReasons: allowlistDecision.reviewReasons,
			rationale: allowlistDecision.rationale,
			activationId: allowlist?.activationId,
			status: allowlist?.status,
			killSwitch: allowlist?.killSwitch,
			counts: allowlist
				? {
						contacts: allowlist.contactIds.length,
						kitSubscribers: allowlist.kitSubscriberIds.length,
						emailHashes: allowlist.emailHashes.length,
						candidates: allowlist.candidates.length,
					}
				: null,
		},
		authorization: allowlist
			? {
					authorizationId: allowlist.activationId,
					name: allowlist.name,
					status: allowlist.status,
					authorizationMode: allowlist.authorizationMode,
					pathSlugs: allowlist.pathSlugs,
					participantCounts: {
						contacts: contactIds.length,
					},
					activationSnapshotParticipantCounts: {
						contacts: allowlist.contactIds.length,
						kitSubscribers: allowlist.kitSubscriberIds.length,
						emailHashes: allowlist.emailHashes.length,
					},
					allowedActions: allowlist.allowedActions,
					preAuthorizedReviewReasons: allowlist.preAuthorizedReviewReasons,
					stopFor: allowlist.stopFor,
					retryPolicy: allowlist.retryPolicy,
					maxSendsPerRun: allowlist.maxSendsPerRun,
					coversFullPath: coversFullSkillsWorkflowPath(allowlist),
					approvedBy: allowlist.approvedBy,
					approvedAt: allowlist.approvedAt,
					updatedAt: allowlist.updatedAt,
				}
			: null,
		totals: {
			contacts: contactIds.length,
			intents: intents.length,
			pending: intents.filter(
				(intent) =>
					intent.status === 'pending' && !isValuePathIntentCompleted(intent),
			).length,
			completed: intents.filter(isValuePathIntentCompleted).length,
			blocked: intents.filter((intent) => intent.status === 'blocked').length,
			stale: intents.filter((intent) => intent.status === 'stale').length,
		},
		computed: {
			state: runState.state,
			plainLanguage: runState.plainLanguage,
			participantsTotal: contactIds.length,
			currentStepDistribution,
			completedPathCount,
			movement,
			nextSendsDue: computedDrip?.counts.planned ?? 0,
			drip: computedDrip,
			retrying,
			hardBlockers,
			hiddenConfigBlockers,
			nextRetryAt: retrying.nextRetryAt,
		},
		grouped,
		eventTypes,
		byContact,
	}
}

async function buildValuePathContactStateInit(args: { allowWrite: boolean }) {
	const checkedAt = new Date().toISOString()
	const allowlistDecision = await readActiveGateDRuntimeAllowlist({ redis })
	const allowlist = allowlistDecision.allowlist
		? normalizeGateDRuntimeAllowlist(allowlistDecision.allowlist)
		: undefined
	if (!allowlist) {
		return {
			mode: args.allowWrite ? 'allow-write' : 'dry-run',
			checkedAt,
			counts: { contacts: 0, existing: 0, planned: 0, created: 0 },
			results: [],
			reason: 'gate-d-allowlist-missing',
		}
	}
	const repository = await createCaptureRepository()
	const results = []
	for (const contactId of allowlist.contactIds) {
		const contact = await repository.findContactById(contactId)
		if (!contact) {
			results.push({ status: 'blocked', contactId, reason: 'contact-missing' })
			continue
		}
		const existing = await repository.findCurrentContactState(contact.id)
		if (existing) {
			results.push({
				status: 'skipped',
				contactId: contact.id,
				reason: 'contact-state-exists',
			})
			continue
		}
		const state: ContactState = {
			id: repository.newId('contact_state'),
			contactId: contact.id,
			lifecycle: 'nurture-ready',
			primaryBucket: 'ai-coding-workflow-real-engineering',
			allBuckets: ['ai-coding-workflow-real-engineering', 'unclear'],
			whySignals: ['ai-coding-workflow-real-engineering'],
			whoSignals: ['unclear'],
			confidence: 0.7,
			rationale: [
				'Initialized from approved Gate D Value Path recent-subscriber cohort.',
			],
			reviewSignals: [],
			humanReview: false,
			lastEventId: `gate-d-allowlist:${allowlist.activationId}`,
			schemaVersion: CONTACT_STATE_SCHEMA_VERSION,
			updatedAt: checkedAt,
		}
		if (args.allowWrite) await repository.upsertContactState(state)
		results.push({
			status: args.allowWrite ? 'created' : 'planned',
			contactId: contact.id,
		})
	}
	return {
		mode: args.allowWrite ? 'allow-write' : 'dry-run',
		checkedAt,
		activationId: allowlist.activationId,
		counts: {
			contacts: allowlist.contactIds.length,
			existing: results.filter((result) => result.status === 'skipped').length,
			planned: args.allowWrite
				? 0
				: results.filter((result) => result.status === 'planned').length,
			created: args.allowWrite
				? results.filter((result) => result.status === 'created').length
				: 0,
			blocked: results.filter((result) => result.status === 'blocked').length,
		},
		results,
		kitWrites: false,
		sequenceEnrollments: false,
		customerVisibleSideEffects: false,
	}
}

async function buildValuePathGateDStart(args: {
	allowWrite: boolean
	valuePathSlug: string
	emailResourceId: string
	kitSequenceId: string
	acceptedReviewReasons: string[]
}) {
	const allowlist = await requireActiveGateDAllowlist()
	return startValuePathGateDActivation({
		repository: await createCaptureRepository(),
		allowlist,
		allowWrite: args.allowWrite,
		valuePathSlug: args.valuePathSlug,
		emailResourceId: args.emailResourceId,
		kitSequenceId: args.kitSequenceId,
		acceptedReviewReasons: resolveGateDPreAuthorizedReviewReasons({
			allowlist,
			explicitReviewReasons: args.acceptedReviewReasons,
			legacyEnvReviewReasons: parseExecutorList(
				process.env.AIH_VALUE_PATH_ACCEPTED_REVIEW_REASONS,
			),
		}),
	})
}

async function buildValuePathDripProgress(args: {
	allowWrite: boolean
	limit: number
	minAgeHours: number
	acceptedReviewReasons: string[]
}) {
	const repository = await createCaptureRepository()
	const allowlist = await requireActiveGateDAllowlist()
	const maxCompletedAt = new Date(
		Date.now() - args.minAgeHours * 60 * 60 * 1000,
	).toISOString()
	const now = new Date().toISOString()
	const cohort = await queryLearnerFlowCohort({ repository, allowlist })
	const completedScan =
		await repository.findCompletedValuePathEmailSideEffectIntentScan({
			limit: args.limit,
			maxCompletedAt,
			now,
			contactIds: cohort.contactIds,
			valuePathSlugs: allowlist.pathSlugs,
			emailResourceIds: allowlist.emailResourceIds,
			kitSequenceIds: allowlist.kitSequenceIds,
		})
	const result = await progressValuePathDrips({
		repository,
		allowlist,
		completedIntents: completedScan.intents,
		allowWrite: args.allowWrite,
		acceptedReviewReasons: resolveGateDPreAuthorizedReviewReasons({
			allowlist,
			explicitReviewReasons: args.acceptedReviewReasons,
			legacyEnvReviewReasons: parseExecutorList(
				process.env.AIH_VALUE_PATH_ACCEPTED_REVIEW_REASONS,
			),
		}),
		now,
	})
	return {
		...result,
		cohort: {
			source: cohort.source,
			contacts: cohort.contactIds.length,
			liveRecordsScanned: cohort.liveRecordsScanned,
		},
		scan: completedScan.diagnostics,
	}
}

async function buildComputedGateDDripStatus(
	allowlist: GateDRuntimeAllowlist,
	cohort: Awaited<ReturnType<typeof queryLearnerFlowCohort>>,
) {
	const repository = await createCaptureRepository()
	const minAgeHours = Number(
		process.env.AIH_VALUE_PATH_DRIP_MIN_AGE_HOURS || 18,
	)
	const maxCompletedAt = new Date(
		Date.now() - minAgeHours * 60 * 60 * 1000,
	).toISOString()
	const now = new Date().toISOString()
	const completedScan =
		await repository.findCompletedValuePathEmailSideEffectIntentScan({
			limit: 200,
			maxCompletedAt,
			now,
			contactIds: cohort.contactIds,
			valuePathSlugs: allowlist.pathSlugs,
			emailResourceIds: allowlist.emailResourceIds,
			kitSequenceIds: allowlist.kitSequenceIds,
		})
	const result = await progressValuePathDrips({
		repository,
		allowlist,
		completedIntents: completedScan.intents,
		allowWrite: false,
		acceptedReviewReasons: resolveGateDPreAuthorizedReviewReasons({
			allowlist,
			legacyEnvReviewReasons: parseExecutorList(
				process.env.AIH_VALUE_PATH_ACCEPTED_REVIEW_REASONS,
			),
		}),
		now,
	})
	const blocked = result.results.filter((item) => item.status === 'blocked')
	return {
		counts: result.counts,
		cohort: {
			source: cohort.source,
			contacts: cohort.contactIds.length,
			liveRecordsScanned: cohort.liveRecordsScanned,
		},
		scan: completedScan.diagnostics,
		blockedReasons: countReviewReasons(blocked),
		planned: result.results
			.filter((item) => item.status === 'planned')
			.map((item) => ({
				contactId: item.contactId,
				fromEmailResourceId: item.fromEmailResourceId,
				nextEmailResourceId: item.nextEmailResourceId,
				nextKitSequenceId: item.nextKitSequenceId,
			})),
		blocked: blocked.map((item) => ({
			contactId: item.contactId,
			fromEmailResourceId: item.fromEmailResourceId,
			nextEmailResourceId: item.nextEmailResourceId,
			nextKitSequenceId: item.nextKitSequenceId,
			reviewReasons: item.reviewReasons,
		})),
	}
}

function summarizeRetryingValuePathIntents(
	intents: Array<{
		status: string
		reviewReasons: string[]
		metadata: Record<string, unknown>
	}>,
	now: string,
) {
	const retryable = intents.filter(
		(intent) =>
			intent.status === 'failed' && intent.metadata.retryable === true,
	)
	const retryableDue = retryable.filter((intent) => {
		const nextRetryAt = stringField(intent.metadata.nextRetryAt)
		return !nextRetryAt || nextRetryAt <= now
	})
	const retryableWaiting = retryable.filter((intent) => {
		const nextRetryAt = stringField(intent.metadata.nextRetryAt)
		return Boolean(nextRetryAt && nextRetryAt > now)
	})
	const hardFailed = intents.filter(
		(intent) =>
			intent.status === 'failed' && intent.metadata.retryable !== true,
	)
	const retryTimes = retryableWaiting
		.map((intent) => stringField(intent.metadata.nextRetryAt))
		.filter((value): value is string => Boolean(value))
		.sort()
	return {
		retryableDue: retryableDue.length,
		retryableWaiting: retryableWaiting.length,
		nextRetryAt: retryTimes[0],
		hardFailed: hardFailed.length,
		hardFailedReasons: countReviewReasons(hardFailed),
	}
}

function countReviewReasons(
	items: Array<{ reviewReasons?: readonly string[] }>,
) {
	return countByValues(items.flatMap((item) => [...(item.reviewReasons ?? [])]))
}

function mergeReasonCounts(
	...counts: Array<Record<string, number> | undefined>
) {
	const merged: Record<string, number> = {}
	for (const count of counts) {
		for (const [reason, value] of Object.entries(count ?? {})) {
			merged[reason] = (merged[reason] ?? 0) + value
		}
	}
	return merged
}

function pickReasonCounts(
	counts: Record<string, number>,
	reasons: readonly string[],
) {
	const picked: Record<string, number> = {}
	for (const reason of reasons) {
		const value = counts[reason]
		if (value !== undefined) picked[reason] = value
	}
	return picked
}

function countByValues(values: readonly string[]) {
	const counts: Record<string, number> = {}
	for (const value of values) counts[value] = (counts[value] ?? 0) + 1
	return counts
}

function isTerminalValuePathEmailResourceId(value: string) {
	return value.endsWith('.email-6') || value.endsWith('.team-email-6')
}

function coversFullSkillsWorkflowPath(allowlist: GateDRuntimeAllowlist) {
	return (
		SKILLS_WORKFLOW_PATH_SLUGS.every((slug) =>
			allowlist.pathSlugs.includes(slug),
		) &&
		SKILLS_WORKFLOW_EMAIL_RESOURCE_IDS.every((id) =>
			allowlist.emailResourceIds.includes(id),
		) &&
		SKILLS_WORKFLOW_KIT_SEQUENCE_IDS.every((id) =>
			allowlist.kitSequenceIds.includes(id),
		)
	)
}

async function requireActiveGateDAllowlist() {
	const decision = await readActiveGateDRuntimeAllowlist({ redis })
	if (!decision.passed || !decision.allowlist) {
		throw new Error(
			`Gate D Runtime Allowlist is not active: ${decision.reviewReasons.join(', ')}`,
		)
	}
	return normalizeGateDRuntimeAllowlist(decision.allowlist)
}

function candidatePreviewToAllowlistCandidate(
	candidate: GateDCandidatePreviewItem,
): GateDRuntimeAllowlist['candidates'][number] {
	return {
		contactId: candidate.contactId!,
		kitSubscriberId: candidate.kitSubscriberId,
		email: candidate.email,
		emailHash: candidate.emailHash,
		domain: candidate.domain,
		scheduleEvidence: candidate.scheduleEvidence,
		rationale: candidate.rationale,
		blockers: candidate.blockers,
	}
}

function redactAllowlistForOutput(allowlist: GateDRuntimeAllowlist) {
	return {
		...allowlist,
		emails: allowlist.emails.map(() => '<redacted-email>'),
		candidates: allowlist.candidates.map((candidate) => ({
			...candidate,
			email: candidate.email ? '<redacted-email>' : undefined,
		})),
	}
}

async function buildSignupGapOperatorPreview(args: {
	formId: number
	from: string
	to: string
}): Promise<SignupGapPreview> {
	const records = await fetchKitFormSubscriberRecords({
		formId: String(args.formId),
		addedAfter: args.from,
	})
	const subscribers: SignupGapKitSubscriber[] = records.map((subscriber) => {
		if (!subscriber.createdAt) {
			throw new Error(
				`Kit subscriber ${subscriber.kitSubscriberId} is missing created_at`,
			)
		}
		return {
			kitSubscriberId: subscriber.kitSubscriberId,
			email: subscriber.email,
			firstName: subscriber.firstName,
			createdAt: subscriber.createdAt,
			fields: subscriber.fields,
		}
	})
	return buildSignupGapPreview({
		subscribers,
		identityMatches: await fetchSignupGapIdentityMatches(subscribers),
		formId: args.formId,
		from: args.from,
		to: args.to,
	})
}

async function fetchSignupGapIdentityMatches(
	subscribers: SignupGapKitSubscriber[],
) {
	const emails = Array.from(
		new Set(
			subscribers
				.map((subscriber) => normalizeSignupGapEmail(subscriber.email))
				.filter((email): email is string => Boolean(email)),
		),
	)
	const kitSubscriberIds = Array.from(
		new Set(subscribers.map((subscriber) => subscriber.kitSubscriberId)),
	)
	const contactEmails = new Set<string>()
	const matchedKitSubscriberIds = new Set<string>()

	for (const emailChunk of chunk(emails, 500)) {
		const rows = await db
			.select({ email: contact.email })
			.from(contact)
			.where(inArray(contact.email, emailChunk))
		for (const row of rows) {
			const email = normalizeSignupGapEmail(row.email)
			if (email) contactEmails.add(email)
		}
	}
	for (const idChunk of chunk(kitSubscriberIds, 500)) {
		const rows = await db
			.select({ externalId: providerIdentity.externalId })
			.from(providerIdentity)
			.where(
				and(
					eq(providerIdentity.provider, 'kit'),
					inArray(providerIdentity.externalId, idChunk),
				),
			)
		for (const row of rows) matchedKitSubscriberIds.add(row.externalId)
	}

	return {
		contactEmails,
		kitSubscriberIds: matchedKitSubscriberIds,
	}
}

async function fetchContactMatchesForSkillsSubscribers(
	subscribers: SkillsFormSubscriberEvidence[],
) {
	const emails = Array.from(
		new Set(
			subscribers
				.map((subscriber) => normalizeEmail(subscriber.email))
				.filter((email): email is string => Boolean(email)),
		),
	)
	const contactRows: Array<{
		contact: typeof contact.$inferSelect
		contactState: typeof contactState.$inferSelect | null
	}> = []
	for (const emailChunk of chunk(emails, 500)) {
		contactRows.push(
			...(await db
				.select({ contact, contactState })
				.from(contact)
				.leftJoin(contactState, eq(contactState.contactId, contact.id))
				.where(inArray(contact.email, emailChunk))),
		)
	}
	const contactIds = contactRows.map(({ contact }) => contact.id)
	const completedContactIds = new Set<string>()
	for (const idChunk of chunk(contactIds, 500)) {
		const intents = await db
			.select({
				contactId: sideEffectIntent.contactId,
				completedAt: sideEffectIntent.completedAt,
				metadata: sideEffectIntent.metadata,
			})
			.from(sideEffectIntent)
			.where(
				and(
					inArray(sideEffectIntent.contactId, idChunk),
					eq(sideEffectIntent.type, 'send-value-path-email'),
				),
			)
		for (const intent of intents) {
			const emailResourceId = String(intent.metadata?.emailResourceId ?? '')
			if (
				isValuePathIntentCompleted(intent) &&
				/(?:^|\.)(?:email-6|team-email-6)$/.test(emailResourceId)
			) {
				completedContactIds.add(intent.contactId)
			}
		}
	}
	return contactRows.flatMap(({ contact, contactState }) => {
		const email = normalizeEmail(contact.email)
		if (!email) return []
		return [
			{
				contactId: contact.id,
				email,
				lifecycle: (contactState?.lifecycle ??
					contact.lifecycle) as ContactMatchEvidence['lifecycle'],
				humanReview: contactState?.humanReview ?? false,
				reviewSignals: (contactState?.reviewSignals ?? []) as NonNullable<
					ContactMatchEvidence['reviewSignals']
				>,
				alreadyCompletedPath: completedContactIds.has(contact.id),
			},
		]
	}) satisfies ContactMatchEvidence[]
}

function chunk<T>(items: T[], size: number) {
	const chunks: T[][] = []
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size))
	}
	return chunks
}

async function fetchRecentQuickQuestionReplies(args: { recentDays: number }) {
	const since = new Date(Date.now() - args.recentDays * 24 * 60 * 60 * 1000)
	const rows = await db
		.select({ contact, contactEvent, contactState })
		.from(contactEvent)
		.innerJoin(contact, eq(contact.id, contactEvent.contactId))
		.leftJoin(contactState, eq(contactState.contactId, contact.id))
		.where(
			and(
				inArray(contactEvent.eventType, [
					'quick-question.reply',
					'quick-question.follow-up-reply',
				]),
				gte(contactEvent.occurredAt, since),
			),
		)
		.orderBy(desc(contactEvent.occurredAt))
		.limit(1000)
	return rows.map(({ contact, contactEvent, contactState }) => {
		const identityEvidence = contactEvent.identityEvidence as Record<
			string,
			unknown
		>
		return {
			contactId: contact.id,
			email:
				contact.email ??
				(typeof identityEvidence.email === 'string'
					? identityEvidence.email
					: ''),
			occurredAt: contactEvent.occurredAt.toISOString(),
			lifecycle: (contactState?.lifecycle ?? contact.lifecycle) as
				| QuickQuestionReplyEvidence['lifecycle']
				| undefined,
			humanReview: contactState?.humanReview ?? false,
			reviewSignals: (contactState?.reviewSignals ?? []) as NonNullable<
				QuickQuestionReplyEvidence['reviewSignals']
			>,
		}
	}) satisfies QuickQuestionReplyEvidence[]
}

type KitFormSubscriberRecord = {
	kitSubscriberId: string
	email: string
	firstName?: string
	createdAt?: string
	addedAt: string
	fields?: Record<string, unknown>
}

async function fetchKitFormSubscribers(args: {
	formId: string
	recentDays: number
}) {
	const addedAfter = new Date(
		Date.now() - args.recentDays * 24 * 60 * 60 * 1000,
	).toISOString()
	return (await fetchKitFormSubscriberRecords({ ...args, addedAfter })).map(
		({ kitSubscriberId, email, addedAt, fields }) => ({
			kitSubscriberId,
			email,
			subscribedAt: addedAt,
			fields,
		}),
	) satisfies SkillsFormSubscriberEvidence[]
}

async function fetchKitFormSubscriberRecords(args: {
	formId: string
	addedAfter: string
}) {
	const apiKey =
		process.env.CONVERTKIT_V4_API_KEY ?? process.env.CONVERTKIT_API_KEY
	if (!apiKey) {
		throw new Error(
			'Kit form subscriber preview requires CONVERTKIT_V4_API_KEY or CONVERTKIT_API_KEY',
		)
	}
	const subscribers: KitFormSubscriberRecord[] = []
	let cursor: string | undefined
	for (let page = 0; page < 100; page++) {
		const url = new URL(
			`https://api.convertkit.com/v4/forms/${args.formId}/subscribers`,
		)
		url.searchParams.set('status', 'active')
		url.searchParams.set('per_page', '1000')
		url.searchParams.set(
			'added_after',
			new Date(args.addedAfter).toISOString().slice(0, 10),
		)
		if (cursor) url.searchParams.set('after', cursor)
		const response = await fetchKitSignupGapPageWithRetry({
			request: () =>
				fetch(url, {
					headers: { 'X-Kit-Api-Key': apiKey },
				}),
		})
		const data = (await response.json()) as Record<string, any>
		if (!response.ok) {
			throw new Error(
				`Kit form subscriber query failed: ${response.status} ${JSON.stringify(data)}`,
			)
		}
		subscribers.push(...parseKitFormSubscriberRecords(data))
		cursor = stringField(data.pagination?.end_cursor)
		if (!cursor || data.pagination?.has_next_page === false) return subscribers
	}
	throw new Error('Kit form subscriber query exceeded the 100-page safety cap')
}

function parseKitFormSubscribersExport(
	source: string,
): SkillsFormSubscriberEvidence[] {
	return parseKitFormSubscriberPayload(JSON.parse(source))
}

function parseKitFormSubscriberPayload(
	payload: unknown,
): SkillsFormSubscriberEvidence[] {
	return parseKitFormSubscriberRecords(payload).map(
		({ kitSubscriberId, email, addedAt, fields }) => ({
			kitSubscriberId,
			email,
			subscribedAt: addedAt,
			fields,
		}),
	)
}

function parseKitFormSubscriberRecords(
	payload: unknown,
): KitFormSubscriberRecord[] {
	const record = payload as Record<string, unknown>
	const subscribers = Array.isArray(record.subscribers)
		? record.subscribers
		: Array.isArray(payload)
			? payload
			: []
	return subscribers.flatMap((value) => {
		const subscriber = value as Record<string, unknown>
		const email =
			stringField(subscriber.email_address) ?? stringField(subscriber.email)
		const id = stringField(subscriber.id) ?? numberField(subscriber.id)
		if (!email || !id) return []
		const fields =
			subscriber.fields && typeof subscriber.fields === 'object'
				? (subscriber.fields as Record<string, unknown>)
				: undefined
		const createdAt = stringField(subscriber.created_at)
		const addedAt =
			stringField(subscriber.added_at) ??
			stringField(subscriber.subscribed_at) ??
			stringField(
				(subscriber.subscription as Record<string, unknown>)?.created_at,
			) ??
			createdAt
		if (!addedAt) {
			throw new Error(
				'Kit form subscriber payload is missing a usable subscribed-at timestamp. Provide an explicit export with added_at, subscribed_at, or created_at.',
			)
		}
		return [
			{
				kitSubscriberId: id,
				email,
				firstName: stringField(subscriber.first_name),
				createdAt,
				addedAt,
				fields,
			},
		]
	})
}

function stringField(value: unknown) {
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberField(value: unknown) {
	return typeof value === 'number' || typeof value === 'bigint'
		? String(value)
		: undefined
}

async function buildSeenContentPreview(args: {
	contactId: string
	limit: number
}) {
	const snapshot = await buildContactSnapshot(args.contactId, args.limit)
	return previewSeenContent({
		contactId: snapshot.contact.id,
		events: snapshot.recentEvents,
	})
}

async function buildContactSnapshot(contactId: string, limit: number) {
	const lookupRepository = await createLookupRepository()
	const lookup = await lookupSubscriberMarketingContact({
		repository: lookupRepository,
		input: { type: 'contact-id', contactId },
		limit,
	})
	const snapshot = lookup.contacts[0]
	if (!snapshot) throw new Error(`Contact ${contactId} was not found`)
	return snapshot
}

async function buildValuePathPreview(contactId: string) {
	const { valuePath } = await buildSnapshotAndValuePath(contactId)
	return valuePath
}

async function buildSnapshotAndValuePath(contactId: string) {
	const lookupRepository = await createLookupRepository()
	const purchaseRepository = await createPurchasePreviewRepository()
	const lookup = await lookupSubscriberMarketingContact({
		repository: lookupRepository,
		input: { type: 'contact-id', contactId },
		limit: 10,
	})
	const snapshot = lookup.contacts[0]
	if (!snapshot) throw new Error(`Contact ${contactId} was not found`)
	const purchases = await purchaseRepository.findPurchasesByProductIds([
		'product-9wdta',
		'product-7t9ek',
	])
	const contactEmail = normalizeEmail(snapshot.contact.email)
	const purchaseFacts = purchases.filter((purchase) => {
		const purchaseEmail = normalizeEmail(purchase.email)
		return (
			(Boolean(contactEmail) && purchaseEmail === contactEmail) ||
			(Boolean(snapshot.contact.userId) &&
				purchase.userId === snapshot.contact.userId)
		)
	})
	return {
		snapshot,
		valuePath: previewValuePathForContactSnapshot({
			snapshot,
			purchaseFacts,
		}),
	}
}

async function buildContentReadEventPreview(args: {
	limit: number
	sampleLimit: number
	allowWrite: boolean
}) {
	const { db } = await import('@/db')
	const { contentRead } = await import('@/db/schema')
	const { desc } = await import('drizzle-orm')
	const rows = await db
		.select()
		.from(contentRead)
		.orderBy(desc(contentRead.occurredAt))
		.limit(args.limit)
	const repository = await createCaptureRepository()
	if (args.allowWrite) {
		return writeContentReadContactEvents({
			repository,
			rows,
			sampleLimit: args.sampleLimit,
		})
	}
	return previewContentReadContactEvents({
		repository,
		rows,
		sampleLimit: args.sampleLimit,
	})
}

async function buildShortlinkClickEventPreview(args: {
	limit: number
	sampleLimit: number
}) {
	const { db } = await import('@/db')
	const { shortlink, shortlinkClick } = await import('@/db/schema')
	const { desc, eq } = await import('drizzle-orm')
	const rows = await db
		.select({ click: shortlinkClick, shortlink })
		.from(shortlinkClick)
		.leftJoin(shortlink, eq(shortlink.id, shortlinkClick.shortlinkId))
		.orderBy(desc(shortlinkClick.timestamp))
		.limit(args.limit)
	return previewShortlinkClickContactEvents({
		repository: await createCaptureRepository(),
		rows: rows.map(({ click, shortlink }) => ({
			id: click.id,
			shortlinkId: click.shortlinkId,
			slug: shortlink?.slug,
			url: shortlink?.url,
			timestamp: click.timestamp,
			metadata: click.metadata,
			shortlinkMetadata: shortlink?.metadata,
		})),
		sampleLimit: args.sampleLimit,
	})
}

async function buildContentReadRetention(args: {
	retentionDays?: number
	allowWrite: boolean
}) {
	const retention = await import('@/lib/content-read-retention')
	return args.allowWrite
		? retention.deleteExpiredAnonymousContentReads({
				retentionDays: args.retentionDays,
			})
		: retention.previewExpiredAnonymousContentReads({
				retentionDays: args.retentionDays,
			})
}

async function buildAiHeroUserIdentityLinks(args: { limit: number }) {
	const { db } = await import('@/db')
	const { contentRead } = await import('@/db/schema')
	const { desc, isNotNull } = await import('drizzle-orm')
	const rows = await db
		.select({ userId: contentRead.userId })
		.from(contentRead)
		.where(isNotNull(contentRead.userId))
		.orderBy(desc(contentRead.occurredAt))
		.limit(args.limit * 5)
	return linkAiHeroUserIdentities({
		repository: await createCaptureRepository(),
		userIds: Array.from(
			new Set(
				rows.map((row) => row.userId).filter((id): id is string => Boolean(id)),
			),
		).slice(0, args.limit),
	})
}

async function buildKitSubscriberIdentityLinks(args: { limit: number }) {
	const kitSubscriberIds = await fetchRecentContentReadKitSubscriberIds(
		args.limit,
	)
	const { emailListProvider } =
		await import('@/coursebuilder/email-list-provider')
	return linkKitSubscriberIdentities({
		repository: await createCaptureRepository(),
		kit: emailListProvider,
		kitSubscriberIds,
	})
}

async function buildKitSubscriberIdentityLinksDryRun(args: { limit: number }) {
	return previewKitSubscriberIdentityLinks({
		kitSubscriberIds: await fetchRecentContentReadKitSubscriberIds(args.limit),
	})
}

async function buildKitSubscriberIdentityLinksFromPreview(args: {
	candidatePreviewPath: string
	allowWrite: boolean
}) {
	const envelope = JSON.parse(await readFile(args.candidatePreviewPath, 'utf8'))
	const preview = (envelope.result ?? envelope) as GateDCandidatePreview
	const kitSubscriberIds = preview.candidates
		.map((candidate) => candidate.kitSubscriberId)
		.filter((id): id is string => Boolean(id))
	return args.allowWrite
		? linkKitSubscriberIdentities({
				repository: await createCaptureRepository(),
				kit: (await import('@/coursebuilder/email-list-provider'))
					.emailListProvider,
				kitSubscriberIds,
			})
		: previewKitSubscriberIdentityLinks({ kitSubscriberIds })
}

async function fetchRecentContentReadKitSubscriberIds(limit: number) {
	const { db } = await import('@/db')
	const { contentRead } = await import('@/db/schema')
	const { desc, isNotNull } = await import('drizzle-orm')
	const rows = await db
		.select({ kitSubscriberId: contentRead.kitSubscriberId })
		.from(contentRead)
		.where(isNotNull(contentRead.kitSubscriberId))
		.orderBy(desc(contentRead.occurredAt))
		.limit(limit * 5)
	return Array.from(
		new Set(
			rows
				.map((row) => row.kitSubscriberId)
				.filter((id): id is string => Boolean(id)),
		),
	).slice(0, limit)
}

async function previewKitSubscriberIdentityLinks(args: {
	kitSubscriberIds: string[]
}) {
	const { emailListProvider } =
		await import('@/coursebuilder/email-list-provider')
	const results = []
	for (const kitSubscriberId of Array.from(new Set(args.kitSubscriberIds))) {
		const existingIdentity = await db.query.providerIdentity.findFirst({
			where: and(
				eq(providerIdentity.provider, 'kit'),
				eq(providerIdentity.externalId, kitSubscriberId),
			),
		})
		if (existingIdentity) {
			results.push({
				status: 'skipped',
				kitSubscriberId,
				reason: 'already-linked',
				contactId: existingIdentity.contactId,
			})
			continue
		}
		const subscriber = await emailListProvider.getSubscriber(kitSubscriberId)
		const email = normalizeEmail(subscriber?.email_address)
		if (!subscriber) {
			results.push({
				status: 'skipped',
				kitSubscriberId,
				reason: 'subscriber-not-found',
			})
			continue
		}
		if (!email) {
			results.push({
				status: 'skipped',
				kitSubscriberId,
				reason: 'subscriber-email-missing',
			})
			continue
		}
		const existingContact = await db.query.contact.findFirst({
			where: eq(contact.email, email),
		})
		results.push({
			status: 'would-link',
			kitSubscriberId,
			contactId: existingContact?.id,
			wouldCreateContact: !existingContact,
			wouldCreateProviderIdentity: true,
		})
	}
	return {
		mode: 'dry-run' as const,
		checkedCount: args.kitSubscriberIds.length,
		wouldLinkCount: results.filter((result) => result.status === 'would-link')
			.length,
		wouldCreateContactCount: results.filter(
			(result) => result.status === 'would-link' && result.wouldCreateContact,
		).length,
		skippedCount: results.filter((result) => result.status === 'skipped')
			.length,
		results,
		kitWrites: false as const,
		sequenceEnrollments: false as const,
		customerVisibleSideEffects: false as const,
	}
}

async function buildShadowFieldCandidates(args: {
	limit: number
	scanLimit: number
	status?: 'review-only' | 'human-review' | 'blocked'
	noReviewReasons: boolean
}) {
	const { db } = await import('@/db')
	const { contact, contactState } = await import('@/db/schema')
	const { and, desc, eq } = await import('drizzle-orm')
	const rows = await db
		.select({ contact })
		.from(contactState)
		.innerJoin(contact, eq(contact.id, contactState.contactId))
		.where(
			and(
				eq(contactState.lifecycle, 'classified'),
				eq(contactState.humanReview, false),
			),
		)
		.orderBy(desc(contactState.updatedAt))
		.limit(args.scanLimit)
	const lookupRepository = await createLookupRepository()
	const snapshots = await Promise.all(
		rows.map(({ contact }) =>
			lookupSubscriberMarketingContact({
				repository: lookupRepository,
				input: { type: 'contact-id', contactId: contact.id },
				limit: 10,
			}).then((lookup) => lookup.contacts[0]),
		),
	)
	return previewShadowFieldCandidates({
		snapshots: snapshots.filter(
			(snapshot): snapshot is NonNullable<typeof snapshot> => Boolean(snapshot),
		),
		status: args.status,
		noReviewReasons: args.noReviewReasons,
		limit: args.limit,
	})
}

async function createLookupRepository() {
	const { db } = await import('@/db')
	return new DrizzleOperatorLookupRepository(db)
}

async function createCaptureRepository() {
	const { db } = await import('@/db')
	return new DrizzleCaptureMarketingRepository(db)
}

async function createLearnerFlowCanaryRepository(): Promise<
	DrizzleCaptureMarketingRepository & LearnerFlowCanaryRepository
> {
	const repository = await createCaptureRepository()
	return Object.assign(repository, {
		findLearnerFlowCanaryContacts: async () => {
			const rows = await db
				.select({ id: contact.id })
				.from(contact)
				.where(learnerFlowCanaryEmailSql(contact.email))
				.orderBy(desc(contact.createdAt))
			const contacts = await Promise.all(
				rows.map((row) => repository.findContactById(row.id)),
			)
			return contacts.filter(
				(record): record is NonNullable<typeof record> => Boolean(record),
			)
		},
		deleteLearnerFlowFixtureContact: async (contactId: string) => {
			await db.transaction(async (transaction) => {
				await transaction
					.delete(googleAdsSignupConversionUpload)
					.where(eq(googleAdsSignupConversionUpload.contactId, contactId))
				await transaction
					.delete(sideEffectIntent)
					.where(eq(sideEffectIntent.contactId, contactId))
				await transaction
					.delete(nextAction)
					.where(eq(nextAction.contactId, contactId))
				await transaction
					.delete(stateTransition)
					.where(eq(stateTransition.contactId, contactId))
				await transaction
					.delete(contactEvent)
					.where(eq(contactEvent.contactId, contactId))
				await transaction
					.delete(contactLink)
					.where(eq(contactLink.contactId, contactId))
				await transaction
					.delete(providerIdentity)
					.where(eq(providerIdentity.contactId, contactId))
				await transaction
					.delete(contactState)
					.where(eq(contactState.contactId, contactId))
				await transaction.delete(contact).where(eq(contact.id, contactId))
			})
		},
		readLearnerFlowFixtureResidue: readLearnerFlowFixtureResidue,
	})
}

async function readLearnerFlowFixtureResidue(
	contactId: string,
): Promise<LearnerFlowCanaryResidue> {
	const [
		contacts,
		contactStates,
		providerIdentities,
		contactEvents,
		stateTransitions,
		nextActions,
		sideEffectIntents,
		contactLinks,
		conversionUploads,
	] = await Promise.all([
		countRows(contact, eq(contact.id, contactId)),
		countRows(contactState, eq(contactState.contactId, contactId)),
		countRows(providerIdentity, eq(providerIdentity.contactId, contactId)),
		countRows(contactEvent, eq(contactEvent.contactId, contactId)),
		countRows(stateTransition, eq(stateTransition.contactId, contactId)),
		countRows(nextAction, eq(nextAction.contactId, contactId)),
		countRows(sideEffectIntent, eq(sideEffectIntent.contactId, contactId)),
		countRows(contactLink, eq(contactLink.contactId, contactId)),
		countRows(
			googleAdsSignupConversionUpload,
			eq(googleAdsSignupConversionUpload.contactId, contactId),
		),
	])
	return {
		contacts,
		contactStates,
		providerIdentities,
		contactEvents,
		stateTransitions,
		nextActions,
		sideEffectIntents,
		contactLinks,
		conversionUploads,
		total:
			contacts +
			contactStates +
			providerIdentities +
			contactEvents +
			stateTransitions +
			nextActions +
			sideEffectIntents +
			contactLinks +
			conversionUploads,
	}
}

async function countRows(table: any, where: any) {
	const rows = await db.select({ value: count() }).from(table).where(where)
	return Number(rows[0]?.value ?? 0)
}

async function createPurchasePreviewRepository() {
	const { db } = await import('@/db')
	return new DrizzlePurchasePreviewRepository(db)
}

async function readCaptureText(args: string[]) {
	const textFile = readFlag(args, '--text-file')
	if (textFile) return readFile(textFile, 'utf8')
	if (args.includes('--stdin')) return readStdin()
	printUsageAndExit()
}

async function readStdin() {
	const chunks: Buffer[] = []
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
	}
	const text = Buffer.concat(chunks).toString('utf8')
	if (!text.trim()) printUsageAndExit()
	return text
}

function requireFlag(args: string[], flag: string) {
	const value = readFlag(args, flag)
	if (!value) printUsageAndExit()
	return value
}

function readFlag(args: string[], flag: string) {
	const index = args.indexOf(flag)
	if (index === -1) return undefined
	const value = args[index + 1]
	if (!value || value.startsWith('--')) printUsageAndExit()
	return value
}

function readAllFlags(args: string[], flag: string) {
	const values: string[] = []
	for (let index = 0; index < args.length; index++) {
		if (args[index] !== flag) continue
		const value = args[index + 1]
		if (!value || value.startsWith('--')) printUsageAndExit()
		values.push(value)
	}
	return values
}

function requireFormId(args: string[]) {
	const formId = readIntegerFlag(args, '--form-id')
	if (!formId) printUsageAndExit()
	return formId
}

function readIntegerFlag(args: string[], flag: string) {
	const value = readFlag(args, flag)
	if (!value) return undefined
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed < 1) printUsageAndExit()
	return parsed
}

/**
 * Reads a CLI flag as a non-negative integer offset.
 *
 * @param args - Raw CLI argument array
 * @param flag - Flag name to look up (e.g. `'--offset'`)
 * @returns Parsed offset, or undefined when the flag is absent
 */
function readOffsetFlag(args: string[], flag: string) {
	const value = readFlag(args, flag)
	if (!value) return undefined
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed < 0) printUsageAndExit()
	return parsed
}

function isProvider(provider: string): provider is Provider {
	return providers.includes(provider as Provider)
}

function parseShadowFieldCandidateStatus(status: string) {
	if (
		status === 'review-only' ||
		status === 'human-review' ||
		status === 'blocked'
	) {
		return status
	}
	printUsageAndExit()
}

function normalizeEmail(value?: string | null) {
	const normalized = value?.trim().toLowerCase()
	return normalized && normalized.includes('@') ? normalized : undefined
}

function operatorWorkspaceRoot() {
	return process.cwd().endsWith('/apps/ai-hero')
		? resolve(process.cwd(), '../..')
		: process.cwd()
}

function defaultCompletedAtBackfillReceiptPath(result: {
	mode: 'dry-run' | 'allow-write'
	generatedAt: string
}) {
	const timestamp = result.generatedAt.replace(/[:.]/g, '-').toLowerCase()
	return `.brain/data/learner-flow/receipts/${timestamp}-completed-at-backfill-${result.mode}.json`
}

function printUsageAndExit(): never {
	console.error(`Usage:
  pnpm --filter ai-hero subscriber-marketing:operator lookup --email person@example.com
  pnpm --filter ai-hero subscriber-marketing:operator lookup --contact-id contact_123
  pnpm --filter ai-hero subscriber-marketing:operator lookup --user-id user_123
  pnpm --filter ai-hero subscriber-marketing:operator lookup --provider kit --external-id sub_123
  pnpm --filter ai-hero subscriber-marketing:operator replay-preview --contact-id contact_123 [--event-id event_123]
  pnpm --filter ai-hero subscriber-marketing:operator signup-gap-preview --form-id 9376133 --from 2026-07-14T22:00:00-07:00 --to 2026-07-15T08:00:00-07:00
  pnpm --filter ai-hero subscriber-marketing:operator signup-gap-replay --form-id 9376133 --from 2026-07-14T22:00:00-07:00 --to 2026-07-15T08:00:00-07:00 --allow-write [--source signup-gap-replay]
  pnpm --filter ai-hero subscriber-marketing:operator seen-content-preview --contact-id contact_123 [--limit 100]
  pnpm --filter ai-hero subscriber-marketing:operator seen-content-kit-sync --contact-id contact_123 --dry-run [--limit 100]
  pnpm --filter ai-hero subscriber-marketing:operator seen-content-kit-sync --contact-id contact_123 --allow-write [--limit 100]
  pnpm --filter ai-hero subscriber-marketing:operator capture-front --conversation-id cnv_123 --text-file /tmp/reply.txt [--message-id msg_123] [--sender-email person@example.com] [--front-contact-id cnt_123] [--follow-up] [--restricted]
  pbpaste | pnpm --filter ai-hero subscriber-marketing:operator capture-front --conversation-id cnv_123 --stdin [--message-id msg_123]
  pnpm --filter ai-hero subscriber-marketing:operator capture-front-csv --quick-question-csv /path/to/qq.csv [--dry-run] [--limit 25]
  pnpm --filter ai-hero subscriber-marketing:operator purchase-preview --quick-question-csv /path/to/qq.csv [--quick-question-analysis-json /path/to/analysis.json] [--product-id product-9wdta]
  pnpm --filter ai-hero subscriber-marketing:operator matched-purchaser-value-path-preview --quick-question-csv /path/to/qq.csv [--product-id product-9wdta] [--limit 25]
  pnpm --filter ai-hero subscriber-marketing:operator value-path-import-preview --individual-sequence-mdx /path/to/individual-sequence.mdx --team-sequence-mdx /path/to/team-sequence.mdx --individual-answer-pages-mdx /path/to/individual-answer-pages.mdx --team-answer-pages-mdx /path/to/team-answer-pages.mdx [--dry-run]
  pnpm --filter ai-hero subscriber-marketing:operator value-path-import-preview --individual-sequence-mdx /path/to/individual-sequence.mdx --team-sequence-mdx /path/to/team-sequence.mdx --individual-answer-pages-mdx /path/to/individual-answer-pages.mdx --team-answer-pages-mdx /path/to/team-answer-pages.mdx --allow-write --created-by-id user_123
  pnpm --filter ai-hero subscriber-marketing:operator value-path-qa-preview --individual-sequence-mdx /path/to/individual-sequence.mdx --team-sequence-mdx /path/to/team-sequence.mdx --individual-answer-pages-mdx /path/to/individual-answer-pages.mdx --team-answer-pages-mdx /path/to/team-answer-pages.mdx [--team-share-link-map-json /path/to/link-map.json]
  pnpm --filter ai-hero subscriber-marketing:operator value-path-preview --contact-id contact_123
  pnpm --filter ai-hero subscriber-marketing:operator value-path-gate-d-preview [--kit-form-id 9376133] [--recent-days 14] [--target-count 20] [--kit-export-json /path/to/export.json] [--include-emails true] [--require-quick-question-reply true]
  pnpm --filter ai-hero subscriber-marketing:operator value-path-gate-d-activate --candidate-preview /path/to/preview.json --activation-id skills-workflow:2026-05-14-a --dry-run
  pnpm --filter ai-hero subscriber-marketing:operator value-path-gate-d-activate --candidate-preview /path/to/preview.json --activation-id skills-workflow:2026-05-14-a --allow-write [--approved-by operator] [--authorization-mode finish-approved-path|rolling-public-enrollment]
  pnpm --filter ai-hero subscriber-marketing:operator value-path-gate-d-status
  pnpm --filter ai-hero subscriber-marketing:operator value-path-completion-survey-sync --dry-run
  pnpm --filter ai-hero subscriber-marketing:operator value-path-completion-survey-sync --allow-write [--created-by-id user_123]
  pnpm --filter ai-hero subscriber-marketing:operator learner-flow-fixture-stuck [--fixture-id <id>] [--allow-write]
  pnpm --filter ai-hero subscriber-marketing:operator learner-flow-fixture-stuck --cleanup --contact-id <synthetic-contact-id> [--allow-write]
  pnpm --filter ai-hero subscriber-marketing:operator learner-flow-canary [--status|--tick] [--allow-write]
  pnpm --filter ai-hero subscriber-marketing:operator learner-flow-canary --seed [--stalled] [--now <iso>] [--allow-write]
  pnpm --filter ai-hero subscriber-marketing:operator learner-flow-canary --cleanup [--allow-write]
  pnpm --filter ai-hero subscriber-marketing:operator value-path-completed-at-backfill [--dry-run] [--receipt .brain/data/learner-flow/receipts/receipt.json]
  pnpm --filter ai-hero subscriber-marketing:operator value-path-completed-at-backfill --allow-write [--receipt .brain/data/learner-flow/receipts/receipt.json]
  pnpm --filter ai-hero subscriber-marketing:operator learner-flow-stuck-list [--json]
  pnpm --filter ai-hero subscriber-marketing:operator learner-flow-unstick [--json] [--signup-gap-form-id 9376133]
  pnpm --filter ai-hero subscriber-marketing:operator learner-flow-unstick --allow-write [--json] [--signup-gap-form-id 9376133]
  pnpm --filter ai-hero subscriber-marketing:operator value-path-email-executor --allow-write --mode allowlisted-test --allowlisted-email joel+test@example.com --limit 1 [--intent-id <id>] [--provider-pacing-ms 1500]
  pnpm --filter ai-hero subscriber-marketing:operator shadow-field-preview --contact-id contact_123
  pnpm --filter ai-hero subscriber-marketing:operator content-read-event-preview [--limit 100] [--sample-limit 10] [--allow-write] [--force-large-write]
  pnpm --filter ai-hero subscriber-marketing:operator content-read-event-review-page [--limit 100] [--sample-limit 10]
  pnpm --filter ai-hero subscriber-marketing:operator aih-133-production-receipt [--limit 100]
  pnpm --filter ai-hero subscriber-marketing:operator shortlink-click-event-preview [--limit 100] [--sample-limit 10]
  pnpm --filter ai-hero subscriber-marketing:operator content-read-retention [--retention-days 14] [--allow-write]
  pnpm --filter ai-hero subscriber-marketing:operator link-kit-subscriber-identities --dry-run [--limit 25]
  pnpm --filter ai-hero subscriber-marketing:operator link-kit-subscriber-identities --dry-run --candidate-preview /path/to/preview.json
  pnpm --filter ai-hero subscriber-marketing:operator link-kit-subscriber-identities --allow-write [--limit 25]
  pnpm --filter ai-hero subscriber-marketing:operator link-ai-hero-user-identities --allow-write [--limit 25]
  pnpm --filter ai-hero subscriber-marketing:operator shadow-field-candidates --status review-only --no-review-reasons [--limit 50] [--scan-limit 250]
  pnpm --filter ai-hero subscriber-marketing:operator shadow-field-sync --contact-id contact_123 --dry-run
  pnpm --filter ai-hero subscriber-marketing:operator shadow-field-sync --contact-id contact_123 --allow-write [--accept-review-reason reason-slug]
  pnpm --filter ai-hero subscriber-marketing:operator team-kit-projection --dry-run [--limit 25] [--offset 0] [--skip-kit-lookup] [--kit-lookup-delay-ms 250] [--kit-lookup-max-attempts 3]
  pnpm --filter ai-hero subscriber-marketing:operator team-kit-projection --allow-write --owner-tag-id 123 --member-tag-id 456 [--limit 25] [--offset 0] [--kit-lookup-delay-ms 250] [--kit-lookup-max-attempts 3]`)
	process.exit(1)
}
