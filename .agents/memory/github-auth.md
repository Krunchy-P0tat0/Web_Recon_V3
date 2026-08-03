---
name: GitHub HTTPS authentication
description: Authentication behavior observed when syncing private GitHub repositories from this workspace.
---

For private GitHub repository fetches, a personal access token may authenticate successfully against the GitHub API with Bearer auth but fail for Git's HTTPS transport. Use a temporary `Authorization: Basic` header whose decoded credentials are `x-access-token:<PAT>`; do not put the token in the remote URL or Git config.

**Why:** GitHub accepted the token for repository API inspection but rejected the Bearer header during `git fetch`; the Basic x-access-token form succeeded.

**How to apply:** For one-off fetches, pass the header with `git -c http.extraHeader=... fetch` and keep the configured remote URL token-free.