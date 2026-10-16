export const BULK_CLOCK_MAX_RTT_MS = 250
export const BULK_DB_UTC_EPOCH =
	"TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(6)) DIV 1000"
export type BulkClockSample = {
	utcMs: number
	rttMs: number
	monotonicAt: number
	/** Epoch query floors to milliseconds; an exact injected clock uses zero. */
	precisionMs: number
	monotonicNow?: () => number
}
export type BulkClockProbe = () => Promise<BulkClockSample>
/** At query return, UTC is at least the floored server sample and at most
 * sample + SQL precision + whole RTT. Project that interval to fetch using
 * monotonic elapsed time only; app wall clocks never authorize a POST. */
export function bulkClockBounds(sample: BulkClockSample) {
	const elapsed =
		(sample.monotonicNow ?? (() => performance.now()))() - sample.monotonicAt
	if (
		!Number.isSafeInteger(sample.utcMs) ||
		!Number.isFinite(sample.rttMs) ||
		sample.rttMs < 0 ||
		sample.rttMs > BULK_CLOCK_MAX_RTT_MS ||
		!Number.isFinite(sample.precisionMs) ||
		sample.precisionMs < 0 ||
		!Number.isFinite(elapsed) ||
		elapsed < 0
	)
		return undefined
	const lower = sample.utcMs + elapsed
	return { lower, upper: lower + sample.rttMs + sample.precisionMs }
}
/** One small UTC query inside each POST callback. No transaction, table or
 * pooled-session SET. Pool wait precedes the sample; RTT includes the query. */
type ClockConnection = { query(sql: string): Promise<unknown>; release(): void }
export async function sampleBulkClock(
	acquire: () => Promise<ClockConnection>,
): Promise<BulkClockSample> {
	const connection = await acquire()
	try {
		const start = performance.now()
		const result: unknown = await connection.query(
			`SELECT ${BULK_DB_UTC_EPOCH} AS now`,
		)
		const end = performance.now()
		const rows = (
			Array.isArray(result) ? result[0] : (result as { rows: unknown[] }).rows
		) as { now: unknown }[]
		return {
			utcMs: rows[0]?.now == null ? NaN : Number(rows[0].now),
			rttMs: end - start,
			monotonicAt: end,
			precisionMs: 1,
		}
	} finally {
		connection.release()
	}
}
export const probeDrovrBulkClock: BulkClockProbe = async () => {
	const { acquireDatabaseConnection } = await import('@/db')
	return sampleBulkClock(acquireDatabaseConnection)
}
