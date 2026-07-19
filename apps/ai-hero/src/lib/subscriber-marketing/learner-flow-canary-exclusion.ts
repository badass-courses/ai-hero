import { sql, type SQLWrapper } from 'drizzle-orm'

export const LEARNER_FLOW_CANARY_FIXTURE_ID_PREFIX = 'canary-learner-v1-'
export const LEARNER_FLOW_CANARY_EMAIL_PREFIX = `joel+aih-synth-${LEARNER_FLOW_CANARY_FIXTURE_ID_PREFIX}`
export const LEARNER_FLOW_CANARY_EMAIL_DOMAIN = 'badass.dev'
export const LEARNER_FLOW_CERTIFICATE_TEST_EMAIL = 'joel+certtest@egghead.io'
export const LEARNER_FLOW_DRILL_EMAIL_PREFIXES = [
	'joel+aih-synth-drill-drift-v1-',
	'joel+aih-synth-drill-zombie-v1-',
] as const
const LEARNER_FLOW_CANARY_EMAIL_SQL_PATTERN = `${LEARNER_FLOW_CANARY_EMAIL_PREFIX}%@${LEARNER_FLOW_CANARY_EMAIL_DOMAIN}`
const LEARNER_FLOW_DRILL_EMAIL_SQL_PATTERNS =
	LEARNER_FLOW_DRILL_EMAIL_PREFIXES.map(
		(prefix) => `${prefix}%@${LEARNER_FLOW_CANARY_EMAIL_DOMAIN}`,
	)

export function isLearnerFlowCanaryEmail(value?: string | null) {
	const normalized = value?.trim().toLowerCase()
	if (normalized === LEARNER_FLOW_CERTIFICATE_TEST_EMAIL) return true
	if (!normalized?.startsWith(LEARNER_FLOW_CANARY_EMAIL_PREFIX)) return false
	const domain = `@${LEARNER_FLOW_CANARY_EMAIL_DOMAIN}`
	if (!normalized.endsWith(domain)) return false
	const generation = normalized.slice(
		LEARNER_FLOW_CANARY_EMAIL_PREFIX.length,
		-domain.length,
	)
	return /^[a-z0-9-]+$/.test(generation)
}

export function isLearnerFlowBusinessMetricFixtureEmail(
	value?: string | null,
) {
	const normalized = value?.trim().toLowerCase()
	return Boolean(
		isLearnerFlowCanaryEmail(normalized) ||
			LEARNER_FLOW_DRILL_EMAIL_PREFIXES.some(
				(prefix) =>
					normalized?.startsWith(prefix) &&
					normalized.endsWith(`@${LEARNER_FLOW_CANARY_EMAIL_DOMAIN}`),
			),
	)
}

export function learnerFlowCanaryEmailSql(email: SQLWrapper) {
	return sql`(
		COALESCE(LOWER(TRIM(${email})), '') LIKE ${LEARNER_FLOW_CANARY_EMAIL_SQL_PATTERN}
		OR COALESCE(LOWER(TRIM(${email})), '') = ${LEARNER_FLOW_CERTIFICATE_TEST_EMAIL}
	)`
}

export function learnerFlowDrillEmailSql(email: SQLWrapper) {
	return sql`(
		COALESCE(LOWER(TRIM(${email})), '') LIKE ${LEARNER_FLOW_DRILL_EMAIL_SQL_PATTERNS[0]}
		OR COALESCE(LOWER(TRIM(${email})), '') LIKE ${LEARNER_FLOW_DRILL_EMAIL_SQL_PATTERNS[1]}
	)`
}

export function learnerFlowBusinessMetricFixtureEmailSql(email: SQLWrapper) {
	return sql`(
		${learnerFlowCanaryEmailSql(email)}
		OR ${learnerFlowDrillEmailSql(email)}
	)`
}

/**
 * The one business-metric exclusion for the operational fixture namespaces.
 *
 * The public name stays stable because existing metric queries already call it.
 * Canary behavior is unchanged, and drill fixtures are excluded beside it.
 * Operational learner-flow scans may still opt in to fixtures explicitly.
 */
export function excludeLearnerFlowCanary(input: {
	contactId?: SQLWrapper
	email?: SQLWrapper
}) {
	if (input.email) {
		return sql`NOT (${learnerFlowBusinessMetricFixtureEmailSql(input.email)})`
	}
	if (input.contactId) {
		return sql`NOT EXISTS (
			SELECT 1
			FROM AI_Contact AS learner_flow_fixture_contact
			WHERE learner_flow_fixture_contact.id = ${input.contactId}
				AND ${learnerFlowBusinessMetricFixtureEmailSql(sql.raw('learner_flow_fixture_contact.email'))}
		)`
	}
	throw new Error('Canary exclusion requires a contact id or email column')
}
