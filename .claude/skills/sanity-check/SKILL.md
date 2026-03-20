---
name: sanity-check
description: Run a full sanity check on the vite-plugin-vinext-payload project — lint, format, typecheck, unit tests, and optionally e2e tests (SQLite and/or Cloudflare D1). Use this skill whenever the user says "sanity check", "check everything", "run all checks", "is it clean?", or wants to verify the project is in a shippable state before committing or releasing.

---

Run this skill as a **subagent on sonnet** — it's mechanical work that doesn't need opus. Use `Agent` with `model: "sonnet"` and `run_in_background: true`. Report the result summary when the agent completes.

Run all checks sequentially from the project root. Stop and report on first failure unless the user asks to run everything regardless.

## Steps

1. **Lint**: `npm run lint`
2. **Format**: `npm run fmt:check`
3. **Typecheck**: `npx tsc --noEmit`
4. **Unit tests**: `npm test`
5. **E2E SQLite** (optional, slow — ~2 min): `npm run test:e2e`
6. **E2E Cloudflare D1** (optional, slow — ~2 min): `npm run test:e2e-d1`

Only run steps 5-6 if the user explicitly asks for them:
- "full sanity check" / "everything" → run both e2e tests
- "e2e" / "including e2e" → run SQLite e2e only
- "d1" / "cloudflare" / "including d1" → run D1 e2e only

## Output format

```
Sanity check: vite-plugin-vinext-payload

  lint        ✓
  format      ✓
  typecheck   ✓
  unit tests  ✓  (12/12)
  e2e sqlite  -  (skipped)
  e2e d1      -  (skipped)
```

Use ✓ for pass, ✗ for fail, - for skipped. For tests, include the count. If a step fails, show the error output below it.
