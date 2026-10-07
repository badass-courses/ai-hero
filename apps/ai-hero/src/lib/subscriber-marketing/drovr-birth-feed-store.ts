import {
	BirthFeedCheckpointSchema,
	BirthFeedFailure,
	type BirthFeedStore,
} from './drovr-birth-feed'

export interface BirthFeedRedis {
	eval(script: string, keys: string[], args: string[]): Promise<unknown>
}
const READY = '\u0000birth-feed-ready:v1'
export const LOAD_BIRTH_FEED = `
local checkpoint = redis.call('GET', KEYS[1])
if checkpoint and redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 0 then return 'cache-lost' end
return checkpoint
`
/** Membership and checkpoint advance atomically, only through a consumed page.
 * Compare metadata rather than ordering/decoding the opaque provider cursor.
 * Idempotent replay may repeat a write; a stale writer cannot rewind the feed. */
export const CONSUME_BIRTH_FEED = `
local raw = redis.call('GET', KEYS[1])
local expected = cjson.decode(ARGV[1])
local desired = cjson.decode(ARGV[2])
local function equal(a,b)
  if a == cjson.null or b == cjson.null then return a == b end
  return a.schemaVersion == b.schemaVersion and a.since == b.since and a.resumeCursor == b.resumeCursor and a.asOf == b.asOf and a.phase == b.phase
end
local current = raw and cjson.decode(raw) or cjson.null
if raw and redis.call('SISMEMBER', KEYS[2], ARGV[3]) == 0 then return -1 end
if not equal(current, expected) and not equal(current, desired) then return 0 end
redis.call('SADD', KEYS[2], ARGV[3])
for i=4,#ARGV do redis.call('SADD', KEYS[2], ARGV[i]) end
redis.call('SET', KEYS[1], ARGV[2])
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
