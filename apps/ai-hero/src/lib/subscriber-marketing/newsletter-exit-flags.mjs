/** Unknown values disable this feature, never fail application boot.
 * @param {string | undefined} value
 */
export function parseNewsletterExitFlag(value) {
	return ['true', '1'].includes(value?.trim().toLowerCase() ?? '')
}
