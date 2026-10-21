import type {
	PoolConnection,
	RowDataPacket,
	ResultSetHeader,
} from 'mysql2/promise'
import type {
	StragglerOwner,
	StragglerOwnerStore,
} from './contact-sync-straggler-owner'

/** Only the reserved cursor namespace is used. No new schema or outbox writes.
 * Bootstrap, DBUTC read, claim CAS and commit share one locked transaction;
 * no HTTP, sleeps, logging or broker work runs while the lock is held. */
export function createStragglerOwnerStore(
	acquire: () => Promise<PoolConnection>,
): StragglerOwnerStore {
	return {
		async update(key, change) {
			if (key.length > 255)
				throw new Error('StragglerOwner: cursor name exceeds 255 characters')
			if (!/^straggler-owner:[a-f0-9]{64}$/.test(key))
				throw new Error('StragglerOwner: invalid cursor namespace')
			const connection = await acquire()
			let destroyed = false
			try {
				await connection.beginTransaction()
				// Acquire the duplicate row's X lock directly; INSERT IGNORE can
				// leave competing S locks that deadlock when upgraded FOR UPDATE.
				await connection.query(
					"INSERT INTO `AI_ContactSyncCursor` (`name`, `cursor`) VALUES (?, 'null') ON DUPLICATE KEY UPDATE `name` = `name`",
					[key],
				)
				const [rows] = await connection.query<RowDataPacket[]>(
					"SELECT `cursor`, TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(6)) DIV 1000 AS nowMs FROM `AI_ContactSyncCursor` WHERE `name` = ? FOR UPDATE",
					[key],
				)
				if (rows.length !== 1)
					throw new Error('StragglerOwner: missing locked owner')
				const prior = String(rows[0]!.cursor),
					now = Number(rows[0]!.nowMs)
				const owner = JSON.parse(prior) as StragglerOwner | null
				if (
					!Number.isSafeInteger(now) ||
					(owner &&
						(typeof owner.generation !== 'string' ||
							!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
								owner.generation,
							) ||
							(owner.membershipDigest !== undefined &&
								(typeof owner.membershipDigest !== 'string' ||
									!/^[a-f0-9]{64}$/.test(owner.membershipDigest))) ||
							!['active', 'complete', 'parked'].includes(owner.state) ||
							!Number.isSafeInteger(owner.startedAt) ||
							!Number.isSafeInteger(owner.deadline) ||
							owner.deadline !== owner.startedAt + 7 * 24 * 60 * 60 * 1000 ||
							!Number.isSafeInteger(owner.next) ||
							owner.next < 1))
				)
					throw new Error(
						'StragglerOwner: malformed retained owner or DB clock',
					)
				const next = change(owner ?? undefined, now),
					cursor = JSON.stringify(next.owner)
				if (cursor.length > 500)
					throw new Error('StragglerOwner: cursor exceeds existing column')
				if (cursor !== prior) {
					// Deliberately leave shared cursor bookkeeping timestamps alone.
					// Owner age/liveness is JSON startedAt/deadline/next, never updatedAt.
					const [written] = await connection.query<ResultSetHeader>(
						'UPDATE `AI_ContactSyncCursor` SET `cursor` = ?, `updatedAt` = `updatedAt` WHERE `name` = ? AND `cursor` = ?',
						[cursor, key, prior],
					)
					if (written.affectedRows !== 1)
						throw new Error('StragglerOwner: claim CAS failed')
				}
				await connection.commit()
				return next.value
			} catch (error) {
				try {
					await connection.rollback()
				} catch {
					destroyed = true
					try {
						connection.destroy()
					} catch {
						// Destruction must not mask the original transaction failure.
					}
				}
				throw error
			} finally {
				if (!destroyed) connection.release()
			}
		},
	}
}
