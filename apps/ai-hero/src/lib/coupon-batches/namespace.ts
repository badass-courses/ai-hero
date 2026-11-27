// Shared by request and adapter guards. Keep this module runtime-neutral.
export const SELECTOR_PREFIX = 'c5comp_'
export const ROW_PREFIX = 'batch-coupon-'
export const DIGEST_PREFIX = 'c5hash_'
export const TEMPLATE = 'c5-comp-v1'
export const PRODUCT = 'product-s00zs'

export const inSelectorNamespace = (value: unknown): value is string =>
	typeof value === 'string' && value.toLowerCase().startsWith(SELECTOR_PREFIX)
export const inRowNamespace = (value: unknown): boolean =>
	typeof value === 'string' && value.toLowerCase().startsWith(ROW_PREFIX)
export const isPrivateCompReference = (value: unknown) =>
	inRowNamespace(value) ||
	inSelectorNamespace(value) ||
	(typeof value === 'string' && value.toLowerCase().startsWith(DIGEST_PREFIX))
