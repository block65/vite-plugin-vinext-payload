/**
 * Every rewrite this plugin makes to third-party code is disclosed as data:
 * each plugin module declares what it patches and why, `PATCH_MANIFEST` in
 * main.ts collects the declarations, and the README's patch table is
 * generated from them (`pnpm run docs:patches`).
 */

type PatchKind = "transform" | "config" | "stub" | "file-write";

export interface PatchDeclaration {
	/** Stable identifier, kebab-case, unique across the manifest. */
	id: string;

	/**
	 * `transform` rewrites module code in memory; `file-write` mutates a file
	 * in node_modules on disk; `stub` substitutes a module wholesale;
	 * `config` only adjusts Vite/Rolldown configuration.
	 */
	kind: PatchKind;

	/** The third-party code touched — package and module, one per target. */
	targets: readonly string[];

	/** The upstream defect the patch works around. */
	reason: string;

	upstreamIssues?: readonly string[];

	/** The condition under which the patch should be deleted. */
	removeWhen: string;

	/**
	 * A patch kept as insurance against a fixed upstream regression:
	 * expected to rewrite nothing.
	 */
	defensive?: boolean;
}
