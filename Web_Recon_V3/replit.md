# Web_Recon_V3

A full-pipeline website reconnaissance and replication system: give it any public URL and it crawls, analyses design DNA, generates a blueprint, and deploys a functional replica to Cloudflare R2.

---

## Run & Operate

| Command | Purpose |
|---------|---------|
| `pnpm --filter @workspace/api-server run dev` | Run the API server (port 8080) |
| `pnpm --filter @workspace/dashboard run dev` | Run the dashboard (port 23183) |
| `pnpm run typecheck` | Full typecheck across all packages |
| `pnpm run build` | Typecheck + build all packages |
| `pnpm --filter @workspace/api-spec run codegen` | Regenerate API hooks and Zod schemas from OpenAPI spec |
| `pnpm --filter @workspace/db run push` | Push DB schema changes (dev only) |
| `bash scripts/sync-docs.sh` | **Commit + push the 3 living docs to GitHub immediately** |

---

## Living Documents (always on GitHub)

These three files are the authoritative project memory. They are automatically pushed to GitHub on every commit via `.git/hooks/post-commit`. Never treat them as local-only — they are the recovery point for new Replit sessions.

| File | Purpose |
|------|---------|
| [`PROJECT_STATUS.md`](PROJECT_STATUS.md) | Current phase, what works, known issues, env var checklist |
| [`PROJECT_PLAN.md`](PROJECT_PLAN.md) | Full phase roadmap A–I with exit criteria and conventions |
| [`ARCHITECTURE_INDEX.md`](ARCHITECTURE_INDEX.md) | Authoritative codebase map — routes, libs, pipeline stages, data flow |

**Rule:** After completing any phase or significant change, update these files and run `bash scripts/sync-docs.sh`.

---

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 + Pino logging
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec in `lib/api-spec/openapi.yaml`)
- Frontend: React + Vite + React Query + Wouter
- Storage: Cloudflare R2 (primary) + local filesystem fallback
- Build: esbuild (CJS bundle for API server)

---

## Where Things Live

- **Pipeline entry point:** `artifacts/api-server/src/lib/master-orchestrator.ts`
- **DB schema source of truth:** `lib/db/src/schema/index.ts`
- **API contract source of truth:** `lib/api-spec/openapi.yaml` (never change `info.title`)
- **Generated hooks (DO NOT EDIT):** `lib/api-client-react/src/generated/`
- **Generated Zod schemas (DO NOT EDIT):** `lib/api-zod/src/generated/`
- **Cloud storage abstraction:** `artifacts/api-server/src/cloud/`
- **All route modules:** `artifacts/api-server/src/routes/` (~70+ files)
- **All library engines:** `artifacts/api-server/src/lib/` (~50+ files)

---

## Architecture Decisions

- **Dual mount path** — API server mounts router at both `/api` (internal self-calls) and `/recon-api` (proxy path). Never add a third mount; change `artifact.toml` instead.
- **R2 credentials split** — `R2_ACCOUNT_ID` and `R2_PUBLIC_BASE_URL` are non-secret env vars; `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` are Replit Secrets.
- **SSE event bus** — all pipeline stage transitions emit to the in-process event bus (`src/lib/event-bus.ts`); dashboard subscribes via `GET /api/events`. Never poll stages directly.
- **OpenAPI `info.title` is frozen** — it drives generated filenames. Changing it silently breaks all hook imports.
- **No `console.log` in server code** — use `req.log` in handlers, `logger` singleton elsewhere.

---

## Required Environment Variables

| Variable | Type | Value / Notes |
|----------|------|--------------|
| `DATABASE_URL` | Secret | Postgres connection string |
| `R2_ACCESS_KEY_ID` | Secret | Cloudflare R2 access key |
| `R2_SECRET_ACCESS_KEY` | Secret | Cloudflare R2 secret |
| `R2_BUCKET_NAME` | Secret | e.g. `assets-stencil` |
| `R2_ACCOUNT_ID` | Env Var | `69ba6c6060b1f150465b2f7f71fb9b25` |
| `R2_PUBLIC_BASE_URL` | Env Var | `https://pub-8710859f71744960aa5d89e60cf0eb31.r2.dev` |
| `SESSION_SECRET` | Secret | Express session signing |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | Secret | Pushes living docs to GitHub |

---

## User Preferences

- The three living docs (PROJECT_STATUS.md, PROJECT_PLAN.md, ARCHITECTURE_INDEX.md) must always be pushed to GitHub and never treated as local-only files.
- Always push docs to GitHub after completing any phase or significant task.
- Minimize credit usage: use the GitHub docs as the recovery point instead of re-auditing the codebase at the start of each session.

---

## Gotchas

- **Do not run `pnpm dev` at workspace root** — run individual artifacts via Replit managed workflows.
- **DB changes require `pnpm --filter @workspace/db run push`** — always run against dev before touching prod.
- **After OpenAPI changes, run codegen** before touching frontend code: `pnpm --filter @workspace/api-spec run codegen`.
- **`pnpm install` must run after pulling a new workspace** — the post-commit hook depends on node_modules being present.
- **The `.git/hooks/post-commit` hook auto-pushes docs** — it only fires when `GITHUB_PERSONAL_ACCESS_TOKEN` is set. In a new session, set the secret first.
