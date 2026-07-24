---
name: R2 config pattern
description: How R2 credentials are split between env vars and secrets in this project
---

R2_ACCOUNT_ID and R2_PUBLIC_BASE_URL are stored as shared env vars (non-sensitive).
R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME are stored as Replit Secrets.

Account ID: 69ba6c6060b1f150465b2f7f71fb9b25
Public base URL: https://pub-8710859f71744960aa5d89e60cf0eb31.r2.dev

**Why:** The account ID and public URL appear in public-facing URLs (R2 r2.dev domain), so they are not sensitive. The keys and bucket name are credentials that must be secret.

**How to apply:** When re-configuring R2 in a new session, set the two env vars with setEnvVars and request the three secrets with requestSecrets.
