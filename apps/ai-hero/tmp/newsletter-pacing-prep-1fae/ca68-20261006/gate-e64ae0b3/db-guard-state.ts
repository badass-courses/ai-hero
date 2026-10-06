// Software guard only; no DB/client/env imports, results or repairs.
export const deniedDatabaseOperations: string[] = []
export function denyDatabaseOperation(path: string): never {
	deniedDatabaseOperations.push(path)
	throw new Error(`REAL_DB_CALL_DENIED: ${path}`)
}
/** Import-safe chain; ANY invocation/constructor throws and stays audited.
 * then is absent so module/Promise inspection does not invoke a DB method. */
export function deniedDatabasePort(path: string): object {
	return new Proxy(function () { return denyDatabaseOperation(path) }, {
		get: (_target, key) => key === 'then' ? undefined : deniedDatabasePort(`${path}.${String(key)}`),
		apply: () => denyDatabaseOperation(path),
		construct: () => denyDatabaseOperation(path),
	})
}
/** Inert schema/column pointer; no real ORM table/client is constructed.
 * Callables are denial ports too; this is not a query/result implementation. */
export function importOnlySchema(name: string): object {
	return new Proxy(Object.create(null), {
		get: (_target, key) => key === 'then' ? undefined : deniedDatabasePort(`schema.${name}.${String(key)}`),
	})
}
