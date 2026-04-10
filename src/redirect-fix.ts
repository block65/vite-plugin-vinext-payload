import { Lang, parse } from "@ast-grep/napi";
import type { Plugin } from "vite";
import { dedent } from "./dedent.ts";

/**
 * Catches Next.js redirect errors that leak through the RSC stream
 * during page rendering and converts them to client-side redirects.
 *
 * Payload CMS uses `redirect()` from `next/navigation` for auth
 * checks and route guards. In Next.js, these sentinel errors are
 * caught by the framework and turned into HTTP 302 responses.
 *
 * vinext handles NEXT_REDIRECT for server actions (via
 * `x-action-redirect` headers in app-rsc-entry.ts), but page-level
 * redirects thrown during RSC streaming (e.g. inside async server
 * components or Suspense boundaries) are not intercepted — the error
 * enters the RSC stream via `rscOnError` (which preserves the digest)
 * and surfaces as an uncaught Error on the client:
 *
 *   Uncaught Error: NEXT_REDIRECT:/admin
 *     at resolveErrorDev (react-server-dom-webpack_client__browser.js)
 *
 * Note: vinext DOES catch NEXT_REDIRECT during synchronous element
 * building (`buildAppPageElement` → `resolveAppPageSpecialError`),
 * returning a proper HTTP redirect. This plugin covers the gap where
 * the redirect is thrown during async rendering inside
 * `renderToReadableStream`, after the response has already started
 * streaming.
 *
 * The injected script intercepts the error and performs
 * `location.replace()` (or `location.assign()` for push-type
 * redirects), matching vinext's own fallback for action redirects.
 *
 * Error formats (from vinext's navigation.ts shim):
 *   message: `NEXT_REDIRECT:{url}`                         (raw URL)
 *   digest:  `NEXT_REDIRECT;{type};{encodedUrl}[;{status}]` (URL-encoded)
 *
 * Injection strategy:
 *   - `transformIndexHtml`: Works when vinext dev server renders HTML
 *     in Node.js (no Cloudflare plugin). Vite calls the hook before
 *     sending the HTML response.
 *   - `transform` (SSR entry): When the Cloudflare plugin is active,
 *     HTML is generated inside workerd by vinext's SSR entry, bypassing
 *     `transformIndexHtml` entirely. We transform the SSR entry to
 *     prepend the redirect handler `<script>` to the HTML head injection.
 */

// Inline script injected into <head> — runs before React boots.
// Listens on both `error` (sync throws reported via reportError())
// and `unhandledrejection` (rejected RSC chunks) in capture phase.
const REDIRECT_HANDLER = dedent`
	(function () {
		function handleRedirectError(error) {
			if (!error) return false;

			// Message format: NEXT_REDIRECT:/path (vinext shim, raw URL)
			var message = error.message || "";
			if (message.indexOf("NEXT_REDIRECT:") === 0) {
				location.replace(message.slice(14));
				return true;
			}

			// Digest format: NEXT_REDIRECT;type;encodedUrl[;status]
			var digest = error.digest || "";
			if (digest.indexOf("NEXT_REDIRECT;") === 0) {
				var parts = digest.split(";");
				var url = decodeURIComponent(parts[2] || "");
				if (url) {
					parts[1] === "push" ? location.assign(url) : location.replace(url);
					return true;
				}
			}

			return false;
		}

		addEventListener("error", function (e) {
			if (handleRedirectError(e.error)) e.preventDefault();
		}, true);

		addEventListener("unhandledrejection", function (e) {
			if (handleRedirectError(e.reason)) e.preventDefault();
		});
	})();
`;

// Minified version for embedding in a JS double-quoted string literal.
// Uses single quotes to avoid escaping. No newlines, no backslashes.
const REDIRECT_HANDLER_INLINE =
	"(function(){function h(e){if(!e)return!1;var m=e.message||'';" +
	"if(m.indexOf('NEXT_REDIRECT:')===0){location.replace(m.slice(14));return!0}" +
	"var d=e.digest||'';if(d.indexOf('NEXT_REDIRECT;')===0){var p=d.split(';');" +
	"var u=decodeURIComponent(p[2]||'');if(u){p[1]==='push'?location.assign(u)" +
	":location.replace(u);return!0}}return!1}addEventListener('error',function(e)" +
	"{if(h(e.error))e.preventDefault()},!0);addEventListener('unhandledrejection'," +
	"function(e){if(h(e.reason))e.preventDefault()})})()";

export function payloadRedirectFix(): Plugin {
	return {
		name: "vite-plugin-payload:redirect-fix",

		// Path 1: vinext dev server (Node.js, no Cloudflare plugin).
		// Vite processes the HTML through transformIndexHtml before sending.
		transformIndexHtml() {
			return [
				{
					tag: "script",
					children: REDIRECT_HANDLER,
					injectTo: "head-prepend",
				},
			];
		},

		// Path 2: Cloudflare plugin dev mode.
		// HTML is generated inside workerd by vinext's SSR entry —
		// transformIndexHtml never fires. We transform the SSR entry to
		// prepend the redirect handler <script> to the head injection HTML.
		transform: {
			handler(code, id) {
				if (this.environment?.name !== "ssr") {
					return null;
				}
				if (!id.includes("app-ssr-entry")) {
					return null;
				}
				if (!code.includes("createTickBufferedTransform")) {
					return null;
				}

				// Use AST to find createTickBufferedTransform($RSC, $HTML) and
				// prepend the redirect script to the second argument.
				const root = parse(Lang.JavaScript, code).root();
				const call = root.find("createTickBufferedTransform($RSC, $HTML)");
				if (!call) {
					return null;
				}
				const htmlArg = call.getMatch("HTML");
				if (!htmlArg) {
					return null;
				}
				const scriptTag = `<script>${REDIRECT_HANDLER_INLINE}<\\/script>`;
				const modified = root.commitEdits([
					htmlArg.replace(`"${scriptTag}" + ${htmlArg.text()}`),
				]);

				return { code: modified, map: null };
			},
		},
	};
}
