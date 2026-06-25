import { request } from '../client'

/**
 * Expert catalog client (专家广场).
 *
 * Mirrors `api/hermes/skills.ts#fetchSkills`: a same-origin BFF call
 * (`GET /api/hermes/experts`) that the server proxies to the multitenancy
 * Run Broker (`GET /api/run-broker/experts`). The active-profile header is
 * attached automatically by `request()` (see api/client.ts).
 *
 * Shape mirrors the plugin `experts[]` declaration (experts/expert.yaml →
 * .hermes-plugin/plugin.json). Only display + capability fields are surfaced;
 * persona (agent_md) NEVER reaches the client.
 */

export interface ExpertGovernance {
  env_default?: string
  approval_required?: string[]
  online_requires?: string
}

export interface ExpertInfo {
  id: string
  name: string
  /** Card title (职称/标题). Falls back to `name` when absent. */
  title?: string
  /** One-line intro shown on the card. */
  tagline?: string
  /** Avatar URL/asset path; empty = render an initial placeholder. */
  avatar?: string
  /** Grouping category (专家广场 聚合用). */
  category?: string
  /** Short tags shown on the card. */
  display_tags?: string[]
  /** Featured experts sort first (首屏置顶). */
  featured?: boolean
  /** Owning team (may be null). */
  team?: string | null
  /** Bound skill names — the capability list shown in the detail panel. */
  skills?: string[]
  /** Governance note (approval-required ops / env default). */
  governance?: ExpertGovernance
  /** Plugin id this expert was published from. */
  plugin_id?: string
}

export interface ExpertListResponse {
  experts: ExpertInfo[]
  profile_name?: string
}

export interface ExpertsData {
  experts: ExpertInfo[]
}

/**
 * Fetch the expert catalog for the active (or given) profile.
 * Mirrors `fetchSkills(profile?)`.
 */
export async function fetchExperts(profile?: string): Promise<ExpertsData> {
  const query = profile ? `?profile=${encodeURIComponent(profile)}` : ''
  const res = await request<ExpertListResponse>(`/api/hermes/experts${query}`)
  return { experts: Array.isArray(res.experts) ? res.experts : [] }
}
