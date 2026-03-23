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

export function payloadRedirectFix(): Plugin {
	return {
		name: "vite-plugin-payload:redirect-fix",
		transformIndexHtml() {
			return [
				{
					tag: "script",
					children: REDIRECT_HANDLER,
					injectTo: "head-prepend",
				},
			];
		},
	};
}
