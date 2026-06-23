---
date: 2026-06-23
commit: local
feature: WebUI image upload broker path
impact: Chat-plane image uploads now reach the multitenancy Run Broker as workspace-readable attachment context instead of raw ContentBlock JSON.
---

WebUI chat-plane uploads already store files under the routed profile's `workspace/uploads` directory. The Run Broker request now renders image/file ContentBlocks into the current user message with `/workspace/...` tool paths, so the multitenancy AIAgent can read the same file from its profile workspace cwd. The Responses metadata input is left intact for future multimodal consumers, but the active broker path no longer relies on unused metadata to convey the current image turn.
