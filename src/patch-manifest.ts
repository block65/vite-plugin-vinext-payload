/**
 * Patch disclosure: every rewrite this plugin makes to third-party code is
 * declared as data, announced once per build, and warned about when it no
 * longer finds its target.
 *
 * The declarations are enforced, not documentation: transform plugins gate
 * on their declaration's `moduleId`, so a pattern cannot rewrite code
 * outside what it publicly declares. The README's patch table is generated
 * from the same data (`pnpm run docs:patches`).
 */

import type { Plugin } from "vite";
import { logger } from "./logger.ts";

export type PatchKind = "transform" | "config" | "stub" | "file-write";

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
	 * For `transform`/`file-write` patches with an id-based filter: module ids
	 * the patch may modify. The owning plugin must gate through
	 * `patchApplies`, making the declaration the filter itself. Absent when
	 * the patch is scoped by environment or code shape instead — `targets`
	 * then carries the scope in prose.
	 */
	moduleId?: RegExp;

	/**
	 * A patch kept as insurance against a fixed upstream regression: expected
	 * to match nothing, so exempt from the unapplied-patch warning.
	 */
	defensive?: boolean;

	/**
	 * The rewrite is performed by a third-party plugin, so applications are
	 * never recorded here — exempt from the unapplied-patch warning.
	 */
	untracked?: boolean;
}

/**
 * Process-level so that a config composing both `vinextPayload` and
 * `vinextPayloadWorker` announces once and warns once, not per composition.
 */
const registered = new Map<string, PatchDeclaration>();
const applied = new Map<string, Set<string>>();
const announced = { done: false };
const warned = { done: false };

/** Whether `moduleId` falls inside the patch's declared scope. */
export function patchApplies(
	declaration: PatchDeclaration,
	moduleId: string,
): boolean {
	return declaration.moduleId?.test(moduleId) ?? false;
}

/**
 * Record that a patch modified `moduleId`. Called at the point a transform
 * commits its edits — an unrecorded declared transform is what the
 * end-of-build warning reports.
 */
export function recordPatch(
	declaration: PatchDeclaration,
	moduleId: string,
): void {
	if (declaration.moduleId && !patchApplies(declaration, moduleId)) {
		// A declared filter that disagrees with the plugin's own gating means
		// the disclosure is wrong — surface it, loudly, every time.
		logger.error(
			`patch ${declaration.id} modified a module outside its declared scope`,
			moduleId,
		);
	}

	const modules = applied.get(declaration.id) ?? new Set<string>();
	modules.add(moduleId);
	applied.set(declaration.id, modules);

	logger.debug(`patch ${declaration.id} applied`, moduleId);
}

/** Announce the registered manifest, once per process. */
export function announcePatches(): void {
	if (announced.done) {
		return;
	}
	announced.done = true;

	logger.info(
		`applying ${registered.size} build-time patches to vinext/Payload internals — set DEBUG=vinext-payload to list them`,
	);
	for (const declaration of registered.values()) {
		logger.debug(
			`${declaration.id} (${declaration.kind}): ${declaration.reason}`,
			...declaration.targets,
		);
	}
}

/**
 * Warn, once per process, for every declared tracked transform that never
 * found its target — the silent-miss failure mode this plugin's history is
 * full of.
 */
export function warnUnappliedPatches(): void {
	if (warned.done) {
		return;
	}
	warned.done = true;

	const unapplied = [...registered.values()].filter(
		(declaration) =>
			(declaration.kind === "transform" || declaration.kind === "file-write") &&
			!declaration.defensive &&
			!declaration.untracked &&
			!applied.has(declaration.id),
	);

	for (const declaration of unapplied) {
		logger.warn(
			`patch ${declaration.id} matched nothing in this build — its target moved, and the defect it works around may be back: ${declaration.reason}`,
		);
	}
}

/**
 * Registers the manifest and hooks the announcement into config resolution
 * and the unapplied-patch warning into the end of a full build.
 *
 * Dev servers get the announcement only: transforms run lazily there, so
 * "never applied" carries no information.
 */
export function payloadPatchReport(
	manifest: readonly PatchDeclaration[],
): Plugin {
	for (const declaration of manifest) {
		registered.set(declaration.id, declaration);
	}

	return {
		name: "vite-plugin-payload:patch-report",

		configResolved() {
			announcePatches();
		},

		buildApp: {
			order: "post",
			handler: async () => {
				warnUnappliedPatches();
			},
		},
	};
}
