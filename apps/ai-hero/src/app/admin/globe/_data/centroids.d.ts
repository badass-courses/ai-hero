/**
 * These maps are excluded from tsconfig so tsc does not materialize
 * tens of thousands of JSON keys and OOM CI. Next still bundles the files.
 */
declare module '@/app/admin/globe/_data/us-zip-centroids.json' {
	const centroids: Record<string, readonly [number, number]>
	export default centroids
}

declare module '@/app/admin/globe/_data/city-centroids.json' {
	const centroids: Record<string, readonly [number, number]>
	export default centroids
}

declare module '@/app/admin/globe/_data/region-centroids.json' {
	const centroids: Record<string, readonly [number, number]>
	export default centroids
}
