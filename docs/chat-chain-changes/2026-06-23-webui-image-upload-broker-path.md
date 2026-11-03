---
date: 2026-06-23
commit: local
feature: WebUI image upload broker path
impact: Chat-plane image uploads now reach the multitenancy Run Broker as profile-workspace-readable attachment context instead of raw ContentBlock JSON, including replayed user history.
---

WebUI chat-plane uploads already store files under the routed profile's `workspace/uploads` directory. The Run Broker request now renders image/file ContentBlocks into current and replayed user messages with relative `uploads/...` tool paths, so the multitenancy AIAgent can read the same file from its profile workspace cwd. The Responses metadata input is left intact for future multimodal consumers, but the active broker path no longer relies on unused metadata to convey image turns.

Follow-up from local session `mqqp3wbly94h7d`: `/workspace/uploads/...` is not mounted in the local Mac runtime, and delegating image recognition to async `delegate_task` does not stream the child result back into the WebUI chat. The active broker text therefore uses relative `uploads/...` paths that resolve from the profile workspace cwd, and image blocks explicitly instruct the agent to call `vision_analyze(image_url="uploads/...")` directly instead of using `delegate_task` for image recognition. This does not change generic async delegation result delivery.
