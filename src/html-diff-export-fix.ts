import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "vite";
import { dedent } from "./dedent.ts";
import { tryRead } from "./try-read.ts";

const TARGET_RELATIVE = join(
	"node_modules",
	"@payloadcms",
	"ui",
	"dist",
	"exports",
	"rsc",
	"index.js",
);

const ORIGINAL_EXPORT =
	"export { escapeDiffHTML, getHTMLDiffComponents, unescapeDiffHTML } from '../../elements/HTMLDiff/index.js';";

const PATCHED_REGION_RE =
	/import \{ jsx as _jsx \} from "react\/jsx-runtime";[\s\S]*?export \{ escapeDiffHTML, payloadGetHTMLDiffComponents as getHTMLDiffComponents, unescapeDiffHTML \};/;

const PATCHED_EXPORT = dedent`
	import { jsx as _jsx } from "react/jsx-runtime";
	import { escapeDiffHTML, unescapeDiffHTML } from "../../elements/HTMLDiff/escapeHtml.js";

	const payloadHtmlDiffBaseClass = "html-diff";
	const payloadGetHTMLDiffComponents = ({
		fromHTML = "",
		toHTML = "",
		postProcess,
	}) => {
		let from = fromHTML;
		let to = toHTML;
		if (postProcess) {
			from = postProcess(from);
			to = postProcess(to);
		}
	return {
		From: from
			? _jsx("div", {
					className: payloadHtmlDiffBaseClass + "__diff-old html-diff",
					dangerouslySetInnerHTML: { __html: from },
				})
			: null,
		To: to
			? _jsx("div", {
					className: payloadHtmlDiffBaseClass + "__diff-new html-diff",
					dangerouslySetInnerHTML: { __html: to },
				})
			: null,
		};
	};

	export { escapeDiffHTML, payloadGetHTMLDiffComponents as getHTMLDiffComponents, unescapeDiffHTML };
`;

/**
 * Fixes a Payload RSC export regression seen with latest templates on
 * vinext/Rolldown builds, where `getHTMLDiffComponents` is reported
 * missing from `@payloadcms/ui/dist/elements/HTMLDiff/index.js`.
 */
export function payloadHtmlDiffExportFix(): Plugin {
	let root = process.cwd();

	return {
		name: "vite-plugin-payload:html-diff-export-fix",
		apply: "build",
		enforce: "pre",
		configResolved(config) {
			root = config.root;
		},
		async buildStart() {
			const target = join(root, TARGET_RELATIVE);
			const content = await tryRead(target);
			if (!content) {
				return;
			}
			let updated = content;
			if (PATCHED_REGION_RE.test(updated)) {
				updated = updated.replace(PATCHED_REGION_RE, PATCHED_EXPORT.trimEnd());
			} else if (updated.includes(ORIGINAL_EXPORT)) {
				updated = updated.replace(ORIGINAL_EXPORT, PATCHED_EXPORT.trimEnd());
			} else {
				return;
			}
			if (updated === content) {
				return;
			}
			await writeFile(target, updated);
		},
	};
}
