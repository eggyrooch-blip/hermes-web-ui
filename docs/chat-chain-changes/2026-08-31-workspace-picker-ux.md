---
date: 2026-08-31
pr: "!57"
release: release-20260831-08 (release-20260831-09 retains the same WebUI SHA)
feature: Chat-plane workspace picker UX
impact: The chat picker names the default cloud workspace, stops suggesting host absolute paths, and hides runtime-owned folders without changing session binding or runtime cwd.
---

The chat plane now presents an empty selection as the profile's default workspace and lists only user-facing workspace folders. Dot-prefixed directories plus `uploads` and `runs` remain available to the Files/runtime surfaces but are not offered as workspace choices. The admin plane keeps its existing host-path picker.

MR !57 / pipeline 543059 merged WebUI `8d71f0cbe5817ee680ed88a699aa735a6eca2bc9`. The change first deployed in `release-20260831-08`; the current `release-20260831-09` keeps that WebUI SHA while advancing multitenancy independently. Both release executors passed 12/12 probes and recorded `outcome=SUCCESS`.

In a real signed-in Chrome session at `https://hermes.example.com`, the picker showed the cloud-workspace title, blank-as-default placeholder, `Default workspace`, and ordinary cloud folders. `.ai-docs`, `uploads`, `runs`, and `/home/user/project` were absent. The dialog was cancelled without changing the session workspace. WebUI/public/profile health passed, the four required ports each had one listener, and current-start logs had zero identity/cross-user/credential mismatch or traceback matches. No employee message or cron job was triggered. The generic ftask SPA canary returned an indeterminate `status=?`; it did not contradict the authenticated DOM and release-probe evidence.
