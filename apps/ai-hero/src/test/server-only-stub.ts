/**
 * Stands in for `server-only` under vitest.
 *
 * `server-only` ships no runtime module — it exists so a bundler errors when a
 * server module is pulled into a client bundle. Vite cannot resolve it, so any
 * test whose import graph reaches a server module fails to load. Aliased to
 * this in `vitest.config.ts`.
 *
 * Intentionally empty. Importing it must do nothing.
 */
export {}
