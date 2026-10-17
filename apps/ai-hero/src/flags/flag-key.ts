import { getEnvironment } from './flags-env'

export const FLAG_PREFIX = 'flag:'

export const getFlagKey = (key: string): string =>
	`${FLAG_PREFIX}${getEnvironment()}:${key}`
