/**
 * Stub for `drizzle-kit/api` in RSC/workerd environments.
 *
 * `drizzle-kit/api` provides migration/schema utilities used by
 * `@payloadcms/db-d1-sqlite` for migration generation. It's imported
 * at module level but only invoked during migration commands, not
 * during RSC rendering. The workerd module runner can't resolve it
 * because pnpm strict isolation prevents esbuild from finding the
 * transitive dependency during pre-bundling.
 */
