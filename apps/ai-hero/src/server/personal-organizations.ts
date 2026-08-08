import { courseBuilderAdapter } from '@/db'
import { log } from '@/server/logger'

import { createPersonalOrganizationService } from '@coursebuilder/organizations'

/**
 * The app's single personal-organization policy instance (ADR-0012 section 3).
 * Shared by the Auth.js createUser boundary and the out-of-band
 * find-or-create boundary so both flows provision identically.
 */
export const personalOrganizations = createPersonalOrganizationService({
	organizations: courseBuilderAdapter,
	logger: log,
})
