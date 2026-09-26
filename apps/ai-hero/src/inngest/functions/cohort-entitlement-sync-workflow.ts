import { inngest } from '@/inngest/inngest.server'
import { getCohort } from '@/lib/cohorts-query'
import { findUsersWithCohortEntitlements } from '@/lib/entitlement-sync'
import { log } from '@/server/logger'

import {
	COHORT_ENTITLEMENT_SYNC_USER_EVENT,
	COHORT_UPDATED_EVENT,
} from '../events/cohort-management'

type CohortUser = { user: { id: string; name: string | null; email: string } }

/**
 * Main orchestrator workflow that handles cohort updates.
 * Uses fan-out pattern to process each user in parallel via separate child functions.
 *
 * Architecture:
 * 1. Validate cohort and extract resource IDs (~1-2s)
 * 2. Find all users with entitlements (single batched query, ~1-2s)
 * 3. Fan-out one event per user (processed in parallel by child functions)
 *
 * This ensures the orchestrator completes quickly (~5s) regardless of user count,
 * while each user is processed reliably with individual retries.
 */
export const cohortEntitlementSyncWorkflow = inngest.createFunction(
	{
		id: 'cohort-entitlement-sync-workflow',
		name: 'Sync Entitlements When Cohort is Updated',
	},
	{
		event: COHORT_UPDATED_EVENT,
	},
	async ({ event, step }) => {
		const { cohortId } = event.data
		const source = event.data.source ?? 'cms' // in-flight pre-source events
		const controlPlaneRunId = event.data.controlPlaneRunId ?? null
		const boundedRemovals = event.data.changes?.boundedRemovals
		const startTime = Date.now()

		// Step 1: Validate cohort and extract resource IDs
		const cohortInfo = await step.run('validate-cohort', async () => {
			const cohort = await getCohort(cohortId)

			if (!cohort) {
				throw new Error(`Cohort ${cohortId} not found`)
			}

			// Extract workshop resource IDs only. Cohorts can also have attached
			// reminder emails, and those should not become content entitlements.
			const resourceIds = (cohort.resources || [])
				.map((r: { resource?: { id?: string; type?: string } }) => r.resource)
				.filter(
					(resource): resource is { id: string; type: string } =>
						Boolean(resource?.id) && resource?.type === 'workshop',
				)
				.map((resource) => resource.id)

			await log.info('cohort_entitlement_sync.cohort_validated', {
				cohortId,
				cohortTitle: cohort.fields?.title || 'Unknown',
				resourceCount: resourceIds.length,
			})

			return {
				cohortTitle: cohort.fields?.title || 'Unknown',
				resourceIds,
			}
		})

		// Step 2: Find all users with entitlements (optimized batched query)
		const usersWithEntitlements: CohortUser[] = await step.run(
			'find-users-with-entitlements',
			async () => {
				const users = await findUsersWithCohortEntitlements(cohortId)

				await log.info('cohort_entitlement_sync.users_found', {
					cohortId,
					count: users.length,
				})

				return users
			},
		)

		// Course-sync's plan supplies a bounded detach set. The snapshot must
		// reflect every planned addition and removal before any per-user event
		// can use it. CMS sends no bound and retains its existing path.
		if (boundedRemovals !== undefined) {
			const live = new Set(cohortInfo.resourceIds)
			const invalidBounds =
				!Array.isArray(boundedRemovals) ||
				boundedRemovals.some((id) => typeof id !== 'string')
			const boundedStillLiveCount = invalidBounds
				? 0
				: boundedRemovals.filter((id) => live.has(id)).length
			const addedMissingCount = (
				event.data.changes.resourcesAdded ?? []
			).filter(({ resourceId }) => !live.has(resourceId)).length
			if (invalidBounds || boundedStillLiveCount || addedMissingCount) {
				await log.error('cohort_entitlement_sync.stale_snapshot_refused', {
					cohortId,
					source,
					controlPlaneRunId,
					affectedUserCount: usersWithEntitlements.length,
					boundedStillLiveCount,
					addedMissingCount,
				})
				return {
					status: 'refused' as const,
					reason: 'stale_snapshot' as const,
					cohortId,
					cohortTitle: cohortInfo.cohortTitle,
					usersProcessed: 0,
					affectedUserCount: usersWithEntitlements.length,
				}
			}
		}

		// Early exit if no users
		if (usersWithEntitlements.length === 0) {
			await log.info('cohort_entitlement_sync.early_exit_no_users', {
				cohortId,
				cohortTitle: cohortInfo.cohortTitle,
				reason: 'No users with entitlements found for this cohort',
				duration: Date.now() - startTime,
			})

			return {
				cohortId,
				cohortTitle: cohortInfo.cohortTitle,
				usersProcessed: 0,
				message: 'No users with entitlements found - sync skipped',
			}
		}

		// A successful but empty cohort read is indistinguishable from an
		// accidental missing relation set. Never fan out an empty desired set to
		// purchasers: the per-user diff would revoke every workshop entitlement.
		// Refuse the whole run (including grants) rather than retrying an empty
		// snapshot or sending partially authoritative updates.
		if (cohortInfo.resourceIds.length === 0) {
			await log.error('cohort_entitlement_sync.empty_target_refused', {
				cohortId,
				source,
				controlPlaneRunId,
				affectedUserCount: usersWithEntitlements.length,
			})
			return {
				status: 'refused' as const,
				reason: 'empty_target_with_entitlements' as const,
				cohortId,
				cohortTitle: cohortInfo.cohortTitle,
				usersProcessed: 0,
				affectedUserCount: usersWithEntitlements.length,
			}
		}

		// Step 3: Fan-out events for each user in batches
		// Inngest has payload size limits, so we batch to avoid hitting them
		const BATCH_SIZE = 100
		const batches: CohortUser[][] = []
		for (let i = 0; i < usersWithEntitlements.length; i += BATCH_SIZE) {
			batches.push(usersWithEntitlements.slice(i, i + BATCH_SIZE))
		}

		for (const [batchIndex, batch] of batches.entries()) {
			await step.sendEvent(
				`fan-out-user-sync-events-batch-${batchIndex}`,
				batch.map(({ user }) => ({
					name: COHORT_ENTITLEMENT_SYNC_USER_EVENT,
					data: {
						cohortId,
						userId: user.id,
						userEmail: user.email,
						cohortResourceIds: cohortInfo.resourceIds,
						...(boundedRemovals !== undefined
							? {
									allowedRemovals: boundedRemovals,
									source,
									...(controlPlaneRunId ? { controlPlaneRunId } : {}),
								}
							: {}),
					},
				})),
			)
		}

		await log.info('cohort_entitlement_sync.fanout_completed', {
			cohortId,
			cohortTitle: cohortInfo.cohortTitle,
			usersQueued: usersWithEntitlements.length,
			duration: Date.now() - startTime,
		})

		return {
			cohortId,
			cohortTitle: cohortInfo.cohortTitle,
			usersProcessed: usersWithEntitlements.length,
			message: `Queued ${usersWithEntitlements.length} user sync events`,
		}
	},
)
