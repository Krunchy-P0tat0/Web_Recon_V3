---
name: Web_Recon_V3 setup
description: Port routing, proxy quirks, R2/DB env setup for the cloned Web_Recon_V3 project living in a subdirectory of the main workspace.
---

## Project location
Cloned into `/home/runner/workspace/Web_Recon_V3/`. Git remote is `github` (not `origin`).

## Port routing
- Original workspace `artifacts/api-server` was on port 8080 at `/api` — caused conflict.
- Fixed by changing `artifacts/api-server` previewPath → `/api-template` (port 8080 stays).
- `Web_Recon_V3/artifacts/api-server` runs on port **8082** at `/api` (via managed workflow).
- `Web_Recon_V3/artifacts/dashboard` runs on port **23183** at `/`.
- Proxy routing picked up after workflow restart; initial "Backend Not Configured" was transient.

**Why:** Both the workspace template and Web_Recon_V3 share artifact ID `3B4_FFSkEVBkAeYMFRJ2e` — changing the template's previewPath was the only way to free `/api` without removing it.

**How to apply:** If the proxy shows "Backend Not Configured" for `/api`, restart `Web_Recon_V3/artifacts/api-server: API Server` and wait ~10s for routing to propagate.

## Environment variables
- `R2_ACCOUNT_ID` and `R2_PUBLIC_BASE_URL` set via `setEnvVars` (shared env, written to root `.replit`).
- `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` stored as Replit Secrets.
- Both root `.replit` and `Web_Recon_V3/.replit` define `[userenv.shared]` R2 non-secret vars.

## Database
- DB schema pushed with `pnpm --filter @workspace/db run push` from `Web_Recon_V3/` directory.
- Must re-run after any schema changes before restarting the API server.

## Workflows (managed)
- `Web_Recon_V3/artifacts/api-server: API Server` — the real API
- `Web_Recon_V3/artifacts/dashboard: web` — Mission Control dashboard

## Current phase
Phase H — Polish & Hardening (see Web_Recon_V3/PROJECT_STATUS.md for open items).
