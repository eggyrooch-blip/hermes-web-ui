---
date: 2026-09-03
pr: pending
feature: Chat-native Project entry
impact: Ordinary Hermes Chat now exposes the existing Project picker while legacy Cowork redirects to Chat and visible Workspace selection is removed.
---

The change reuses the existing session list, message panel, composer, Project APIs, session binding store, and Socket transport. The transport now forwards the existing `project.bound` event so first-send freeze state reaches the picker; switching Projects then uses the existing fresh-session branch. Project Session cards show Project identity instead of the internal folder. The Project chip exposes description and instructions, and the existing Projects page lists bound task Sessions and persisted artifacts without blocking on a newly created Session's detail hydration.

The Projects-page `New task` action now explicitly creates a fresh Session and binds the Project before routing, so it never reopens the current task merely because that task already belongs to the same Project. Local real-account UAT found and fixed this reuse bug plus a paired multitenancy omission where Project descriptions were not included in the frozen Agent context. The final local run passed five consecutive real Run Broker/AIAgent turns and reload persistence; focused Vitest passed 104/104, Chromium passed 1/1, and the production build passed. Production remains unchanged until the authorized ftask release completes.
