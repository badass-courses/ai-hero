import {
	BIRTH_FEED_MAX_CALLS,
	BirthFeedCheckpointSchema,
	BirthFeedFailure,
	type BirthFeedStore,
} from './drovr-birth-feed'
import { OWNER_BIRTH_GUARD_CONFIRMATION_CAP } from './owner-birth-guard'

export interface BirthFeedRedis {
	eval(script: string, keys: string[], args: string[]): Promise<unknown>
}
const READY = '__aih_birth_feed_ready_v1__'
export const BIRTH_FEED_QUOTA_TTL_SECONDS = 48 * 60 * 60
export const BIRTH_CONFIRMATION_COOLDOWN_SECONDS = 6 * 60 * 60
/** Temporary scheduling hint only; never evidence of birth or absence.
 * NX makes retry/replay idempotent without extending the original cooldown. */
export const DEFER_BIRTH_CONFIRMATION = `
redis.call('SET', KEYS[1], '1', 'EX', tonumber(ARGV[1]), 'NX')
return 1
`
export const DEFERRED_BIRTH_CONFIRMATIONS = `
local result = {}
for i=1,#KEYS do result[i] = redis.call('EXISTS', KEYS[i]) end
return result
`
/** Finish is bounded at 55m. Retention is much longer, so active retries
 * cannot gain quota from expiration; old run counters do not accumulate. */
export const RESERVE_BIRTH_FEED_CALL = `
local calls = redis.call('INCR', KEYS[1])
if calls == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2])) end
if calls > tonumber(ARGV[1]) then return 0 end
return 1
`
export const LOAD_BIRTH_FEED = `
local checkpoint = redis.call('GET', KEYS[1])
if not checkpoint and redis.call('EXISTS', KEYS[2]) == 1 then return 'cache-lost' end
if checkpoint and redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 0 then return 'cache-lost' end
return checkpoint
`
/** Membership and checkpoint advance atomically, only through a consumed page.
 * A shed hold may save bootstrap since or retry metadata at an UNCHANGED cursor.
 * Compare metadata rather than interpreting opaque cursors. Retry deadlines
 * participate in CAS so stale writers cannot silently clear an active hold. */
export const CONSUME_BIRTH_FEED = `
local raw = redis.call('GET', KEYS[1])
local expected = cjson.decode(ARGV[1])
local desired = cjson.decode(ARGV[2])
local function retryEqual(a,b)
  if a == nil or b == nil then return a == b end
  return a.notBefore == b.notBefore and a.status == b.status
end
local function equal(a,b)
  if a == cjson.null or b == cjson.null then return a == b end
  return a.schemaVersion == b.schemaVersion and a.since == b.since and a.resumeCursor == b.resumeCursor and a.asOf == b.asOf and a.phase == b.phase and retryEqual(a.retry,b.retry)
end
local current = raw and cjson.decode(raw) or cjson.null
if raw and redis.call('SISMEMBER', KEYS[2], ARGV[3]) == 0 then return -1 end
if not equal(current, expected) and not equal(current, desired) then return 0 end
redis.call('SADD', KEYS[2], ARGV[3])
for i=4,#ARGV do redis.call('SADD', KEYS[2], ARGV[i]) end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`
export const OBSERVE_BIRTH_FEED = `
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 0 then return 0 end
redis.call('SADD', KEYS[1], ARGV[2])
return 1
`
export const MEMBERS_BIRTH_FEED = `
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 0 then return false end
local result = {}
for i=2,#ARGV do result[i-1] = redis.call('SISMEMBER', KEYS[1], ARGV[i]) end
return result
`

/** No membership TTL: advancing a cursor past evicted positives can fabricate
 * absence. Bounded subject batches, never a full set, enter the SDK's steps. */
export function createRedisBirthFeedStore(options: {
	redis: BirthFeedRedis
	tenantId: string
}): BirthFeedStore {
	const keys = (journeyId: string) => {
		// Hash tag co-locates both keys if the Redis adapter uses a cluster.
		const prefix = `aih:birth-feed:{${encodeURIComponent(options.tenantId)}:${encodeURIComponent(journeyId)}}:v1`
		return [`${prefix}:checkpoint`, `${prefix}:members`]
	}
	const deferKey = (journeyId: string, ownerId: string) =>
		`${keys(journeyId)[0]!.replace(/:checkpoint$/, '')}:confirm-cooldown:${encodeURIComponent(ownerId)}`
	const evaluate = async (
		script: string,
		keyList: string[],
		argv: string[],
	) => {
		try {
			return await options.redis.eval(script, keyList, argv)
		} catch {
			throw new BirthFeedFailure('cache-unavailable')
		}
	}
	return {
		async reserveCall(runId) {
			if (!runId) throw new BirthFeedFailure('run-id-unavailable')
			const key = `aih:birth-feed:{${encodeURIComponent(options.tenantId)}:run}:v1:${encodeURIComponent(runId)}:budget`
			const result = await evaluate(
				RESERVE_BIRTH_FEED_CALL,
				[key],
				[String(BIRTH_FEED_MAX_CALLS), String(BIRTH_FEED_QUOTA_TTL_SECONDS)],
			)
			if (result !== 1) throw new BirthFeedFailure('page-cap-exceeded')
		},
		async reserveConfirmation(runId) {
			if (!runId) throw new BirthFeedFailure('run-id-unavailable')
			const key = `aih:birth-feed:{${encodeURIComponent(options.tenantId)}:run}:v1:${encodeURIComponent(runId)}:confirm-budget`
			if (
				(await evaluate(
					RESERVE_BIRTH_FEED_CALL,
					[key],
					[
						String(OWNER_BIRTH_GUARD_CONFIRMATION_CAP),
						String(BIRTH_FEED_QUOTA_TTL_SECONDS),
					],
				)) !== 1
			)
				throw new BirthFeedFailure('confirmation-cap-exceeded')
		},
		async observeBorn(journeyId, contactId) {
			if (
				(await evaluate(
					OBSERVE_BIRTH_FEED,
					[keys(journeyId)[1]!],
					[READY, contactId],
				)) !== 1
			)
				throw new BirthFeedFailure('membership-unavailable')
		},
		async deferConfirmation(journeyId, ownerId) {
			if (
				(await evaluate(
					DEFER_BIRTH_CONFIRMATION,
					[deferKey(journeyId, ownerId)],
					[String(BIRTH_CONFIRMATION_COOLDOWN_SECONDS)],
				)) !== 1
			)
				throw new BirthFeedFailure('confirmation-cooldown-unavailable')
		},
		async deferredConfirmations(journeyId, ownerIds) {
			if (!ownerIds.length) return new Set<string>()
			const result = await evaluate(
				DEFERRED_BIRTH_CONFIRMATIONS,
				ownerIds.map((id) => deferKey(journeyId, id)),
				[],
			)
			if (
				!Array.isArray(result) ||
				result.length !== ownerIds.length ||
				result.some((value) => value !== 0 && value !== 1)
			)
				throw new BirthFeedFailure('confirmation-cooldown-unavailable')
			return new Set(ownerIds.filter((_id, index) => result[index] === 1))
		},
		async load(journeyId) {
			const value = await evaluate(LOAD_BIRTH_FEED, keys(journeyId), [READY])
			if (value === null) return null
			try {
				return BirthFeedCheckpointSchema.parse(
					typeof value === 'string' ? JSON.parse(value) : value,
				)
			} catch {
				throw new BirthFeedFailure('invalid-checkpoint')
			}
		},
		async consume({ journeyId, previous, checkpoint, contactIds }) {
			const result = await evaluate(CONSUME_BIRTH_FEED, keys(journeyId), [
				JSON.stringify(previous),
				JSON.stringify(checkpoint),
				READY,
				...contactIds,
			])
			if (result !== 1)
				throw new BirthFeedFailure('checkpoint-conflict-or-cache-loss')
		},
		async members({ journeyId, contactIds }) {
			const result = await evaluate(
				MEMBERS_BIRTH_FEED,
				[keys(journeyId)[1]!],
				[READY, ...contactIds],
			)
			if (
				!Array.isArray(result) ||
				result.length !== contactIds.length ||
				result.some((value) => value !== 0 && value !== 1)
			)
				throw new BirthFeedFailure('membership-unavailable')
			return new Set(contactIds.filter((_id, index) => result[index] === 1))
		},
	}
}
