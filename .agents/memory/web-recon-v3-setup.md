---
name: Web Recon V3 setup
description: Migration notes, architecture quirks, and runtime gotchas for the Web_Recon_V3 project in this Replit workspace.
---

## Key facts

- Project is in **Phase H — Polish & Hardening**. Phases A–G complete.
- The imported repository tracks GitHub through `origin`; the active staging branch is `lab-merge`.
- Authoritative docs: `PROJECT_STATUS.md`, `PROJECT_PLAN.md`, `ARCHITECTURE_INDEX.md`.

## Architecture quirks

- API server mounts routes at `/api` AND `/recon-api`. Both listed in `artifacts/api-server/.replit-artifact/artifact.toml` `paths`.
- Dashboard (`artifacts/dashboard`) serves at previewPath `/`. Artifact ID is `artifacts/dashboard`.
- `zod` must be in `external` list in `artifacts/api-server/build.mjs`. esbuild cannot resolve it through pnpm workspace symlinks when bundling across lib packages. api-server declares `zod` directly in `dependencies`, so it is available at runtime.

**Why:** When esbuild bundles the api-server and follows workspace symlinks into lib packages (e.g. `lib/api-zod`), it resolves `zod` from the lib's context. pnpm's symlink structure means esbuild can't traverse to the real package. Since api-server already depends on `zod` directly, externalizing is the correct fix — not bundling a second copy.

**How to apply:** Any new dependency that lives in a `lib/*` package (not directly in api-server) and is declared in that lib's `package.json` may need to be added to the `external` list in `build.mjs` if the build fails with "Could not resolve".

## DB schema

Run `pnpm --filter @workspace/db run push` after any schema change. Tables: `scrape_jobs`, `orchestration_jobs`, `generation_reports`, `construction_reports`, `merge_executions`.

## Required env vars / secrets

- Secrets: `DATABASE_URL`, `SESSION_SECRET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`
- Plain env vars: `R2_ACCOUNT_ID=69ba6c6060b1f150465b2f7f71fb9b25`, `R2_PUBLIC_BASE_URL=https://pub-8710859f71744960aa5d89e60cf0eb31.r2.dev`
- Without R2 creds, the server falls back to local filesystem provider (pipeline still runs, no cloud uploads).

## Replit setup

- The dashboard is the managed web artifact at `/` and the API server is mounted at `/api` and `/recon-api`.
- The development database schema is applied with `pnpm --filter @workspace/db run push`; the five documented pipeline tables are present.
- The GitHub repository exposes the requested branch as `lab-merge` (hyphenated), not `lab merge`.

**Why:** The repository’s imported recovery notes used an older remote name and assumed the dashboard workflow was already registered, while this workspace registers services through artifact metadata.

**How to apply:** Use the branch/paths above when resuming setup, and restart the managed artifact workflows after importing or changing dependencies.

## Generated files — never edit

- `lib/api-client-react/src/generated/` and `lib/api-zod/src/generated/` are overwritten by codegen.
- Do NOT change `info.title` in `lib/api-spec/openapi.yaml` — it controls generated filenames.
- After spec changes: `pnpm --filter @workspace/api-spec run codegen`.
