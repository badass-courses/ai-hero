import { createActor } from 'xstate'

import {
	cleanupLearnerFlowDrillFixtures,
	createLearnerFlowDrillFixtures,
	learnerFlowDrillMachine,
	type LearnerFlowDrillFixture,
	type LearnerFlowDrillRepository,
	type LearnerFlowDrillScenario,
} from './learner-flow-drill'

export type LearnerFlowDrillReconcilerRun = {
	observedAt: string
	payload: Record<string, unknown>
}

export type LearnerFlowDrillPulseEvidence = {
	capturedAt: string
	dripObservedAt?: string
	alarms: Array<{
		id: string
		observedAt?: string
		message?: string
	}>
	identicalRunStreak?: number
}

export type LearnerFlowDrillFixtureReadback = {
	contactId: string
	seedIntentId: string
	seedCompletedAt: string | null
	seedMetadataCompletedAt: string | null
	nextIntentId?: string
	nextIntentStatus?: string
	nextIntentCompletedAt?: string | null
}

export type LearnerFlowDrillObservation = {
	runs: LearnerFlowDrillReconcilerRun[]
	pulse?: LearnerFlowDrillPulseEvidence
}

export type LearnerFlowDrillReceiptPhase =
	| 'drift-induced'
	| 'drift-detected-and-healed'
	| 'zombie-induced'
	| 'zombie-zero-plan-detected'
	| 'zombie-identical-payload-detected'
	| 'zombie-healed'
	| 'cleanup'
	| 'failed'

export type LearnerFlowDrillRunnerPorts = {
	repository: LearnerFlowDrillRepository
	observe(since: string): Promise<LearnerFlowDrillObservation>
	readFixtureReadbacks(
		fixtures: readonly LearnerFlowDrillFixture[],
	): Promise<LearnerFlowDrillFixtureReadback[]>
	writeReceipt(
		phase: LearnerFlowDrillReceiptPhase,
		body: Record<string, unknown>,
	): Promise<string>
	sleep(milliseconds: number): Promise<void>
	now(): string
}

export type LearnerFlowDrillRunResult = {
	mode: 'learner-flow-drill'
	runId: string
	scenario: LearnerFlowDrillScenario
	startedAt: string
	completedAt: string
	zeroHumanTouchWindow: {
		startedAt: string
		endedAt: string
	}
	fixtureCounts: {
		drift: number
		zombie: number
	}
	receipts: string[]
}

export async function runLearnerFlowDrill(args: {
	ports: LearnerFlowDrillRunnerPorts
	runId: string
	scenario: LearnerFlowDrillScenario
	pollMilliseconds?: number
	observationTimeoutMilliseconds?: number
	identicalTimeoutMilliseconds?: number
}) : Promise<LearnerFlowDrillRunResult> {
	const startedAt = args.ports.now()
	const actor = createActor(learnerFlowDrillMachine, {
		input: { runId: args.runId, scenario: args.scenario },
	})
	actor.start()
	actor.send({ type: 'START' })
	const receipts: string[] = []
	let driftFixtures: LearnerFlowDrillFixture[] = []
	let zombieFixtures: LearnerFlowDrillFixture[] = []
	let failure: unknown
	const pollMilliseconds = args.pollMilliseconds ?? 60_000
	// The receipt timestamp, not polling latency, is the one-hour SLA clock.
	// The extra wait margin only allows Axiom ingestion and the read-only poll.
	const observationTimeout =
		args.observationTimeoutMilliseconds ?? 75 * 60 * 1000
	const identicalTimeout =
		args.identicalTimeoutMilliseconds ?? 8 * 60 * 60 * 1000

	try {
		if (args.scenario !== 'zombie') {
			const inducedAt = args.ports.now()
			driftFixtures = await createLearnerFlowDrillFixtures({
				repository: args.ports.repository,
				runId: args.runId,
				scenario: 'drift',
				allowWrite: true,
				now: inducedAt,
			})
			const inducedReadbacks =
				await args.ports.readFixtureReadbacks(driftFixtures)
			if (
				!inducedReadbacks.every(
					(item) =>
						item.seedCompletedAt === null &&
						item.seedMetadataCompletedAt === null,
				)
			) {
				throw new Error('Drift induction failed: a completion fallback is still present')
			}
			receipts.push(
				await args.ports.writeReceipt('drift-induced', {
					mode: 'learner-flow-drill',
					runId: args.runId,
					phase: 'drift-induced',
					inducedAt,
					fixtures: driftFixtures,
					fixtureReadbacks: inducedReadbacks,
					proof: {
						canonicalCompletedAtAbsent: driftFixtures.every(
							(item) => item.intentShape.completedAt === null,
						),
						legacyMetadataCompletedAtAbsent: driftFixtures.every(
							(item) => !item.intentShape.metadataCompletedAt,
						),
					},
				}),
			)
			actor.send({ type: 'DRIFT_INDUCED' })
			const evidence = await waitForEvidence({
				ports: args.ports,
				since: inducedAt,
				pollMilliseconds,
				timeoutMilliseconds: observationTimeout,
				predicate: async (observation) => {
					const run = observation.runs.find(
						(item) =>
							numberField(item.payload.repairedCompletionFacts) >=
								driftFixtures.length &&
							numberField(item.payload.created) >= driftFixtures.length &&
							numberField(item.payload.served) >= driftFixtures.length,
					)
					if (!run || !withinDetectionSla(inducedAt, run.observedAt)) {
						return undefined
					}
					const readbacks =
						await args.ports.readFixtureReadbacks(driftFixtures)
					return readbacks.every(fixtureHealed)
						? { observation, run, readbacks }
						: undefined
				},
			})
			receipts.push(
				await args.ports.writeReceipt('drift-detected-and-healed', {
					mode: 'learner-flow-drill',
					runId: args.runId,
					phase: 'drift-detected-and-healed',
					inducedAt,
					detectedAt: evidence.run.observedAt,
					healedAt: evidence.run.observedAt,
					reconcilerReceiptEvidence: evidence.run,
					fixtureReadbacks: evidence.readbacks,
				}),
			)
			actor.send({ type: 'DRIFT_HEALED' })
		}

		if (args.scenario !== 'drift') {
			const inducedAt = args.ports.now()
			zombieFixtures = await createLearnerFlowDrillFixtures({
				repository: args.ports.repository,
				runId: args.runId,
				scenario: 'zombie',
				allowWrite: true,
				now: inducedAt,
			})
			const zombieInducedReadbacks =
				await args.ports.readFixtureReadbacks(zombieFixtures)
			const suppressionExpiresAt = zombieFixtures[0]?.intentShape.suppressedUntil
			receipts.push(
				await args.ports.writeReceipt('zombie-induced', {
					mode: 'learner-flow-drill',
					runId: args.runId,
					phase: 'zombie-induced',
					inducedAt,
					suppressionExpiresAt,
					suppressionMechanism:
						'reconciler suppression requires the synthetic badass.dev email namespace, the drill-zombie-v1 fixture-id prefix, active drill metadata, and an unexpired per-fixture timestamp',
					fixtures: zombieFixtures,
					fixtureReadbacks: zombieInducedReadbacks,
				}),
			)
			actor.send({ type: 'ZOMBIE_INDUCED' })
			const zeroPlan = await waitForEvidence({
				ports: args.ports,
				since: inducedAt,
				pollMilliseconds,
				timeoutMilliseconds: observationTimeout,
				predicate: (observation) => {
					const run = observation.runs.find(
						(item) =>
							item.payload.zeroPlanWhileStarved === true &&
							numberField(item.payload.planned) === 0 &&
							numberField(item.payload.suppressedFixtureStarved) >=
								zombieFixtures.length,
					)
					const alarm = observation.pulse?.alarms.find(
						(item) =>
							item.id === 'learner-flow-drip-zero-plan-while-starved' &&
							item.observedAt === run?.observedAt,
					)
					return run &&
						alarm &&
						withinDetectionSla(inducedAt, run.observedAt)
						? { observation, run, alarm }
						: undefined
				},
			})
			receipts.push(
				await args.ports.writeReceipt('zombie-zero-plan-detected', {
					mode: 'learner-flow-drill',
					runId: args.runId,
					phase: 'zombie-zero-plan-detected',
					inducedAt,
					detectedAt: zeroPlan.run.observedAt,
					reconcilerReceiptEvidence: zeroPlan.run,
					pulseAlarmEvidence: zeroPlan.alarm,
				}),
			)
			actor.send({ type: 'ZERO_PLAN_DETECTED' })

			const identical = await waitForEvidence({
				ports: args.ports,
				since: inducedAt,
				pollMilliseconds,
				timeoutMilliseconds: identicalTimeout,
				predicate: (observation) => {
					const alarm = observation.pulse?.alarms.find(
						(item) =>
							item.id === 'learner-flow-drip-identical-payloads' &&
							typeof item.observedAt === 'string' &&
							item.observedAt === observation.pulse?.dripObservedAt &&
							item.observedAt >= inducedAt,
					)
					return alarm &&
						(observation.pulse?.identicalRunStreak ?? 0) >= 4
						? { observation, alarm }
						: undefined
				},
			})
			receipts.push(
				await args.ports.writeReceipt(
					'zombie-identical-payload-detected',
					{
						mode: 'learner-flow-drill',
						runId: args.runId,
						phase: 'zombie-identical-payload-detected',
						inducedAt,
						detectedAt: identical.alarm.observedAt,
						pulseAlarmEvidence: identical.alarm,
						pulseEvidence: identical.observation.pulse,
						reconcilerReceiptEvidence:
							identical.observation.runs.slice(-4),
					},
				),
			)
			actor.send({ type: 'IDENTICAL_PAYLOAD_DETECTED' })

			const healed = await waitForEvidence({
				ports: args.ports,
				since: suppressionExpiresAt ?? inducedAt,
				pollMilliseconds,
				timeoutMilliseconds: zombieHealWaitTimeoutMilliseconds({
					now: args.ports.now(),
					suppressionExpiresAt,
					observationMarginMilliseconds: observationTimeout,
				}),
				predicate: async (observation) => {
					const run = observation.runs.find(
						(item) =>
							item.observedAt >= (suppressionExpiresAt ?? inducedAt) &&
							numberField(item.payload.suppressedFixtureStarved) === 0 &&
							numberField(item.payload.served) >= zombieFixtures.length,
					)
					if (!run) return undefined
					const readbacks =
						await args.ports.readFixtureReadbacks(zombieFixtures)
					return readbacks.every(fixtureHealed)
						? { observation, run, readbacks }
						: undefined
				},
			})
			receipts.push(
				await args.ports.writeReceipt('zombie-healed', {
					mode: 'learner-flow-drill',
					runId: args.runId,
					phase: 'zombie-healed',
					inducedAt,
					suppressionExpiresAt,
					healedAt: healed.run.observedAt,
					reconcilerReceiptEvidence: healed.run,
					fixtureReadbacks: healed.readbacks,
				}),
			)
			actor.send({ type: 'ZOMBIE_HEALED' })
		}
	} catch (error) {
		failure = error
		actor.send({
			type: 'FAIL',
			error: error instanceof Error ? error.message : String(error),
		})
		receipts.push(
			await args.ports.writeReceipt('failed', {
				mode: 'learner-flow-drill',
				runId: args.runId,
				phase: 'failed',
				failedAt: args.ports.now(),
				error: error instanceof Error ? error.message : String(error),
			}),
		)
	} finally {
		const cleanup = await cleanupLearnerFlowDrillFixtures({
			repository: args.ports.repository,
			allowWrite: true,
		})
		receipts.push(
			await args.ports.writeReceipt('cleanup', {
				mode: 'learner-flow-drill',
				runId: args.runId,
				phase: 'cleanup',
				cleanedAt: args.ports.now(),
				cleanup,
			}),
		)
		actor.send({ type: 'CLEANED' })
		actor.stop()
	}
	if (failure) throw failure
	const completedAt = args.ports.now()
	return {
		mode: 'learner-flow-drill',
		runId: args.runId,
		scenario: args.scenario,
		startedAt,
		completedAt,
		zeroHumanTouchWindow: { startedAt, endedAt: completedAt },
		fixtureCounts: {
			drift: driftFixtures.length,
			zombie: zombieFixtures.length,
		},
		receipts,
	}
}

export function zombieHealWaitTimeoutMilliseconds(args: {
	now: string
	suppressionExpiresAt?: string
	observationMarginMilliseconds: number
}) {
	const remaining = args.suppressionExpiresAt
		? Math.max(0, Date.parse(args.suppressionExpiresAt) - Date.parse(args.now))
		: 0
	return remaining + args.observationMarginMilliseconds
}

export function parseLearnerFlowDrillAxiomOutput(
	stdout: string,
	since: string,
): LearnerFlowDrillReconcilerRun[] {
	const decoded: unknown = JSON.parse(stdout)
	if (!isRecord(decoded) || !Array.isArray(decoded.matches)) {
		throw new Error('Axiom drill response did not contain matches')
	}
	return decoded.matches
		.flatMap((match): LearnerFlowDrillReconcilerRun[] => {
			if (!isRecord(match)) return []
			const data = isRecord(match.data) ? match.data : undefined
			const payload = isRecord(match.payload)
				? match.payload
				: isRecord(data?.payload)
					? data.payload
					: undefined
			const observedAt =
				typeof match._time === 'string'
					? match._time
					: typeof payload?._time === 'string'
						? payload._time
						: undefined
			if (
				!payload ||
				payload.loop !== 'reconciler' ||
				!observedAt ||
				Number.isNaN(Date.parse(observedAt))
			) {
				return []
			}
			return [
				{
					observedAt: new Date(observedAt).toISOString(),
					payload,
				},
			]
		})
		.filter((run) => run.observedAt >= since)
}

export function parseLearnerFlowDrillPulseOutput(
	stdout: string,
): LearnerFlowDrillPulseEvidence {
	const decoded: unknown = JSON.parse(stdout)
	if (!isRecord(decoded) || !isRecord(decoded.result)) {
		throw new Error('Pulse drill response did not contain a result')
	}
	const sources = isRecord(decoded.result.sources)
		? decoded.result.sources
		: undefined
	const liveness = isRecord(sources?.liveness)
		? sources.liveness
		: undefined
	const current = isRecord(liveness?.current) ? liveness.current : undefined
	if (liveness?.status !== 'available' || !current) {
		throw new Error('Pulse liveness source is unavailable during the drill')
	}
	const loops = isRecord(current.loops) ? current.loops : undefined
	const drip = isRecord(loops?.drip) ? loops.drip : undefined
	const alarms = Array.isArray(current.alarms)
		? current.alarms.flatMap((alarm) => {
				if (!isRecord(alarm) || typeof alarm.id !== 'string') return []
				return [
					{
						id: alarm.id,
						...(typeof alarm.observedAt === 'string'
							? { observedAt: alarm.observedAt }
							: {}),
						...(typeof alarm.message === 'string'
							? { message: alarm.message }
							: {}),
					},
				]
			})
		: []
	return {
		capturedAt:
			typeof decoded.result.generatedAt === 'string'
				? decoded.result.generatedAt
				: new Date(0).toISOString(),
		dripObservedAt:
			typeof drip?.observedAt === 'string' ? drip.observedAt : undefined,
		alarms,
		identicalRunStreak:
			typeof drip?.identicalRunStreak === 'number'
				? drip.identicalRunStreak
				: undefined,
	}
}

async function waitForEvidence<T>(args: {
	ports: LearnerFlowDrillRunnerPorts
	since: string
	pollMilliseconds: number
	timeoutMilliseconds: number
	predicate(
		observation: LearnerFlowDrillObservation,
	): Promise<T | undefined> | T | undefined
}) {
	const deadline = Date.parse(args.ports.now()) + args.timeoutMilliseconds
	while (Date.parse(args.ports.now()) <= deadline) {
		const observation = await args.ports.observe(args.since)
		const result = await args.predicate(observation)
		if (result !== undefined) return result
		await args.ports.sleep(args.pollMilliseconds)
	}
	throw new Error(`Timed out waiting for learner-flow drill evidence after ${args.timeoutMilliseconds}ms`)
}

function fixtureHealed(item: LearnerFlowDrillFixtureReadback) {
	return Boolean(
		item.seedCompletedAt &&
			item.seedMetadataCompletedAt &&
			item.nextIntentId &&
			item.nextIntentStatus === 'completed' &&
			item.nextIntentCompletedAt,
	)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function withinDetectionSla(inducedAt: string, observedAt: string) {
	const elapsed = Date.parse(observedAt) - Date.parse(inducedAt)
	return elapsed >= 0 && elapsed <= 60 * 60 * 1000
}

function numberField(value: unknown) {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
