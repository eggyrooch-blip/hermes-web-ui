/**
 * Self-built session database — completely replaces Hermes CLI dependency.
 * Uses the same ensureTable/getDb pattern as usage-store.ts.
 */
import { isSqliteAvailable, getDb } from '../index'
import { SESSIONS_TABLE, MESSAGES_TABLE } from './schemas'
import { normalizeMessageContentForStorageRole } from './message-content'
import { deleteWorkspaceRunChangeRowsForSession } from './workspace-run-changes-store'

// Re-export types for compatibility with sessions-db.ts consumers
export interface HermesSessionRow {
  id: string
  profile: string
  source: string
  agent: string
  agent_mode: string
  agent_session_id: string
  agent_native_session_id: string
  expert_id: string | null
  expert_label: string | null
  expert_avatar: string | null
  is_archived: boolean
  user_id: string | null
  model: string
  provider: string
  title: string | null
  started_at: number
  ended_at: number | null
  end_reason: string | null
  message_count: number
  tool_call_count: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  billing_provider: string | null
  estimated_cost_usd: number
  actual_cost_usd: number | null
  cost_status: string
  preview: string
  last_active: number
  workspace: string | null
}

export interface HermesMessageRow {
  id: number | string
  session_id: string
  role: string
  content: string
  display_role: string | null
  display_content: string | null
  tool_call_id: string | null
  tool_calls: any[] | null
  tool_name: string | null
  timestamp: number
  token_count: number | null
  finish_reason: string | null
  reasoning: string | null
  reasoning_details?: string | null
  reasoning_content?: string | null
  run_id: string
  client_id: string
}

export interface HermesSessionSearchRow extends HermesSessionRow {
  snippet: string
  matched_message_id: number | null
}

export interface HermesSessionDetailRow extends HermesSessionRow {
  messages: HermesMessageRow[]
  thread_session_count: number
}

// Note: Table schemas and initialization are now centralized in schemas.ts
// Tables are created automatically on bootstrap via initAllHermesTables()

// --- Helpers ---

function parseToolCalls(value: unknown): any[] | null {
  if (value == null || value === '') return null
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function mapSessionRow(row: Record<string, unknown>): HermesSessionRow {
  const rawTitle = row.title != null ? String(row.title) : null
  const preview = String(row.preview || '')
  const title = rawTitle || (preview ? (preview.length > 40 ? preview.slice(0, 40) + '...' : preview) : null)
  return {
    id: String(row.id || ''),
    profile: String(row.profile || 'default'),
    source: String(row.source || 'api_server'),
    agent: String(row.agent || ''),
    agent_mode: String(row.agent_mode || ''),
    agent_session_id: String(row.agent_session_id || ''),
    agent_native_session_id: String(row.agent_native_session_id || ''),
    expert_id: row.expert_id != null ? String(row.expert_id) : null,
    expert_label: row.expert_label != null ? String(row.expert_label) : null,
    expert_avatar: row.expert_avatar != null ? String(row.expert_avatar) : null,
    is_archived: Number(row.is_archived || 0) === 1,
    user_id: row.user_id != null ? String(row.user_id) : null,
    model: String(row.model || ''),
    provider: String(row.provider || ''),
    title,
    started_at: Number(row.started_at || 0),
    ended_at: row.ended_at != null ? Number(row.ended_at) : null,
    end_reason: row.end_reason != null ? String(row.end_reason) : null,
    message_count: Number(row.message_count || 0),
    tool_call_count: Number(row.tool_call_count || 0),
    input_tokens: Number(row.input_tokens || 0),
    output_tokens: Number(row.output_tokens || 0),
    cache_read_tokens: Number(row.cache_read_tokens || 0),
    cache_write_tokens: Number(row.cache_write_tokens || 0),
    reasoning_tokens: Number(row.reasoning_tokens || 0),
    billing_provider: row.billing_provider != null ? String(row.billing_provider) : null,
    estimated_cost_usd: Number(row.estimated_cost_usd || 0),
    actual_cost_usd: row.actual_cost_usd != null ? Number(row.actual_cost_usd) : null,
    cost_status: String(row.cost_status || ''),
    preview: String(row.preview || ''),
    last_active: Number(row.last_active || 0),
    workspace: row.workspace != null ? String(row.workspace) : null,
  }
}

function mapMessageRow(row: Record<string, unknown>): HermesMessageRow {
  return {
    id: typeof row.id === 'number' ? row.id : Number(row.id),
    session_id: String(row.session_id || ''),
    role: String(row.role || ''),
    content: row.content != null ? String(row.content) : '',
    display_role: row.display_role != null ? String(row.display_role) : null,
    display_content: row.display_content != null ? String(row.display_content) : null,
    tool_call_id: row.tool_call_id != null ? String(row.tool_call_id) : null,
    tool_calls: parseToolCalls(row.tool_calls),
    tool_name: row.tool_name != null ? String(row.tool_name) : null,
    timestamp: Number(row.timestamp || 0),
    token_count: row.token_count != null ? Number(row.token_count) : null,
    finish_reason: row.finish_reason != null ? String(row.finish_reason) : null,
    reasoning: row.reasoning != null ? String(row.reasoning) : null,
    reasoning_details: row.reasoning_details != null ? String(row.reasoning_details) : null,
    reasoning_content: row.reasoning_content != null ? String(row.reasoning_content) : null,
    run_id: String(row.run_id || ''),
    client_id: String(row.client_id || ''),
  }
}

// --- Session CRUD ---

export function createSession(data: {
  id: string
  profile?: string
  source?: string
  agent?: string
  agent_mode?: string
  agent_session_id?: string
  agent_native_session_id?: string
  user_id?: string | null
  model?: string
  provider?: string
  title?: string
  workspace?: string
}): HermesSessionRow {
  const now = Math.floor(Date.now() / 1000)
  const source = data.source || 'api_server'
  const agent = data.agent || (source === 'cli' ? 'hermes' : '')
  if (!isSqliteAvailable()) {
    return {
      id: data.id, profile: data.profile || 'default', source, agent,
      agent_mode: data.agent_mode || '',
      agent_session_id: data.agent_session_id || '', agent_native_session_id: data.agent_native_session_id || '',
      expert_id: null, expert_label: null, expert_avatar: null,
      is_archived: false,
      user_id: null, model: data.model || '', provider: data.provider || '', title: data.title || null,
      started_at: now, ended_at: null, end_reason: null,
      message_count: 0, tool_call_count: 0,
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
      billing_provider: null, estimated_cost_usd: 0, actual_cost_usd: null,
      cost_status: '', preview: '', last_active: now, workspace: data.workspace || null,
    }
  }
  const db = getDb()!
  db.prepare(
    `INSERT INTO ${SESSIONS_TABLE} (id, profile, source, agent, agent_mode, agent_session_id, agent_native_session_id, user_id, model, provider, title, started_at, last_active, workspace)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    data.id,
    data.profile || 'default',
    source,
    agent,
    data.agent_mode || '',
    data.agent_session_id || '',
    data.agent_native_session_id || '',
    data.user_id || null,
    data.model || '',
    data.provider || '',
    data.title || null,
    now,
    now,
    data.workspace || null,
  )
  return getSession(data.id)!
}

export function getSession(id: string): HermesSessionRow | null {
  if (!isSqliteAvailable()) return null
  const db = getDb()!
  const row = db.prepare(
    `SELECT * FROM ${SESSIONS_TABLE} WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined
  return row ? mapSessionRow(row) : null
}

export function updateSession(id: string, data: Partial<Omit<HermesSessionRow, 'id' | 'profile'>>): void {
  if (!isSqliteAvailable()) return
  const db = getDb()!
  const fields: string[] = []
  const values: any[] = []
  for (const [key, val] of Object.entries(data)) {
    if (key === 'id' || key === 'profile') continue
    // Skip last_active and ended_at - handle them separately below
    if (key === 'last_active' || key === 'ended_at') continue
    fields.push(`"${key}" = ?`)
    values.push(val)
  }

  // Handle ended_at - only update if provided, otherwise keep existing value
  if (data.ended_at !== undefined) {
    fields.push(`"ended_at" = ?`)
    values.push(data.ended_at)
  }

  // Handle last_active - use provided value or current time
  if (data.last_active !== undefined) {
    fields.push(`"last_active" = ?`)
    values.push(data.last_active)
  }

  if (fields.length === 0) return
  db.prepare(`UPDATE ${SESSIONS_TABLE} SET ${fields.join(', ')} WHERE id = ?`).run(...values, id)
}

export function deleteSession(id: string): boolean {
  if (!isSqliteAvailable()) return false
  const db = getDb()!
  db.exec('BEGIN')
  try {
    deleteWorkspaceRunChangeRowsForSession(db, id)
    db.prepare(`DELETE FROM ${MESSAGES_TABLE} WHERE session_id = ?`).run(id)
    const result = db.prepare(`DELETE FROM ${SESSIONS_TABLE} WHERE id = ?`).run(id)
    db.exec('COMMIT')
    return result.changes > 0
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function clearSessionMessages(id: string): number {
  if (!isSqliteAvailable()) return 0
  const db = getDb()!
  const result = db.prepare(`DELETE FROM ${MESSAGES_TABLE} WHERE session_id = ?`).run(id)
  updateSessionStats(id)
  return Number(result.changes)
}

export function renameSession(id: string, title: string): boolean {
  if (!isSqliteAvailable()) return false
  const db = getDb()!
  const result = db.prepare(`UPDATE ${SESSIONS_TABLE} SET title = ? WHERE id = ?`).run(title, id)
  return result.changes > 0
}

export function setSessionArchived(id: string, archived: boolean): boolean {
  if (!isSqliteAvailable()) return false
  const db = getDb()!
  const result = db.prepare(`UPDATE ${SESSIONS_TABLE} SET is_archived = ? WHERE id = ?`).run(archived ? 1 : 0, id)
  return result.changes > 0
}

export function listSessions(
  profile?: string,
  source?: string,
  limit = 2000,
  options: { includeArchived?: boolean } = {},
): HermesSessionRow[] {
  if (!isSqliteAvailable()) return []
  const db = getDb()!
  const profileFilter = profile?.trim()
  const includeArchived = options.includeArchived === true

  // Use a subquery to generate preview from first user message if not set
  const sql = `
    SELECT
      s.*,
      COALESCE(
        NULLIF(s.preview, ''),
        (
          SELECT SUBSTR(REPLACE(REPLACE(m.content, CHAR(10), ' '), CHAR(13), ' '), 1, 63)
          FROM ${MESSAGES_TABLE} m
          WHERE m.session_id = s.id AND m.role = 'user' AND m.content IS NOT NULL
          ORDER BY m.timestamp, m.id
          LIMIT 1
        ),
        ''
      ) AS preview
    FROM ${SESSIONS_TABLE} s
    WHERE 1 = 1
      ${profileFilter ? 'AND s.profile = ?' : ''}
      ${source ? 'AND s.source = ?' : ''}
      ${includeArchived ? '' : 'AND COALESCE(s.is_archived, 0) = 0'}
    ORDER BY s.last_active DESC
    LIMIT ?
  `

  const params: any[] = []
  if (profileFilter) {
    params.push(profileFilter)
  }
  if (source) {
    params.push(source)
  }
  params.push(limit)

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[]
  return rows.map(mapSessionRow)
}

export function listSessionsByAgent(
  agentId: string,
  options: { userId?: string; source?: string; limit?: number; includeArchived?: boolean } = {},
): HermesSessionRow[] {
  if (!isSqliteAvailable()) return []
  const agentFilter = agentId.trim()
  if (!agentFilter) return []
  const userId = options.userId?.trim()
  const limit = options.limit && options.limit > 0 ? options.limit : 2000
  const db = getDb()!
  const sql = `
    SELECT
      s.*,
      COALESCE(
        NULLIF(s.preview, ''),
        (
          SELECT SUBSTR(REPLACE(REPLACE(m.content, CHAR(10), ' '), CHAR(13), ' '), 1, 63)
          FROM ${MESSAGES_TABLE} m
          WHERE m.session_id = s.id AND m.role = 'user' AND m.content IS NOT NULL
          ORDER BY m.timestamp, m.id
          LIMIT 1
        ),
        ''
      ) AS preview
    FROM ${SESSIONS_TABLE} s
    WHERE s.agent = ?
      ${userId ? 'AND s.user_id = ?' : ''}
      ${options.source ? 'AND s.source = ?' : ''}
      ${options.includeArchived ? '' : 'AND COALESCE(s.is_archived, 0) = 0'}
    ORDER BY s.last_active DESC
    LIMIT ?
  `
  const params: any[] = [agentFilter]
  if (userId) params.push(userId)
  if (options.source) params.push(options.source)
  params.push(limit)
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[]
  return rows.map(mapSessionRow)
}

export function searchSessions(profile: string | null | undefined, query: string, limit = 20): HermesSessionSearchRow[] {
  if (!isSqliteAvailable()) return []
  const profileFilter = profile?.trim()
  const trimmed = query.trim()
  if (!trimmed) {
    return listSessions(profileFilter, undefined, limit).map(s => ({ ...s, snippet: s.preview || '', matched_message_id: null }))
  }
  const db = getDb()!
  const lowered = trimmed.toLowerCase()
  const pattern = `%${lowered}%`

  // Step 1: Find matching sessions
  const sessionRows = db.prepare(
    `SELECT * FROM ${SESSIONS_TABLE}
     WHERE 1 = 1
       ${profileFilter ? 'AND profile = ?' : ''}
       AND COALESCE(is_archived, 0) = 0
       AND (
       LOWER(title) LIKE ? OR LOWER(preview) LIKE ?
       OR id IN (SELECT DISTINCT session_id FROM ${MESSAGES_TABLE} WHERE LOWER(content) LIKE ? OR LOWER(COALESCE(tool_name, '')) LIKE ?)
     )
     ORDER BY last_active DESC LIMIT ?`,
  ).all(...[
    ...(profileFilter ? [profileFilter] : []),
    pattern,
    pattern,
    pattern,
    pattern,
    limit,
  ]) as Record<string, unknown>[]

  if (sessionRows.length === 0) return []

  // Step 2: For each session, find first matching message id + snippet
  const msgQuery = db.prepare(
    `SELECT id, content, tool_name FROM ${MESSAGES_TABLE}
     WHERE session_id = ? AND (LOWER(content) LIKE ? OR LOWER(COALESCE(tool_name, '')) LIKE ?)
     ORDER BY timestamp, id LIMIT 1`,
  )

  return sessionRows.map(row => {
    const session = mapSessionRow(row)
    let snippet = ''
    let matched_message_id: number | null = null

    // Check if session title or preview matches
    const titleLower = (session.title || '').toLowerCase()
    const previewLower = (session.preview || '').toLowerCase()
    const titleIdx = titleLower.indexOf(lowered)
    const previewIdx = previewLower.indexOf(lowered)

    if (titleIdx >= 0) {
      snippet = session.title!.substring(Math.max(0, titleIdx - 20), titleIdx + lowered.length + 60)
    } else if (previewIdx >= 0) {
      snippet = session.preview.substring(Math.max(0, previewIdx - 20), previewIdx + lowered.length + 60)
    } else {
      // Get snippet from matching message
      const msg = msgQuery.get(session.id, pattern, pattern) as { id: number; content: string; tool_name: string | null } | undefined
      if (msg) {
        matched_message_id = msg.id
        const contentLower = msg.content.toLowerCase()
        const idx = contentLower.indexOf(lowered)
        snippet = msg.content.substring(Math.max(0, idx - 20), idx + lowered.length + 60)
      }
    }

    return { ...session, snippet, matched_message_id }
  })
}

export function searchSessionsByAgent(
  agentId: string,
  query: string,
  options: { userId?: string; source?: string; limit?: number; includeArchived?: boolean } = {},
): HermesSessionSearchRow[] {
  if (!isSqliteAvailable()) return []
  const agentFilter = agentId.trim()
  if (!agentFilter) return []
  const userId = options.userId?.trim()
  const limit = options.limit && options.limit > 0 ? options.limit : 20
  const trimmed = query.trim()
  if (!trimmed) {
    return listSessionsByAgent(agentFilter, { userId, source: options.source, limit, includeArchived: options.includeArchived })
      .map(s => ({ ...s, snippet: s.preview || '', matched_message_id: null }))
  }
  const db = getDb()!
  const lowered = trimmed.toLowerCase()
  const pattern = `%${lowered}%`
  const sessionRows = db.prepare(
    `SELECT * FROM ${SESSIONS_TABLE}
     WHERE agent = ?
       ${userId ? 'AND user_id = ?' : ''}
       ${options.source ? 'AND source = ?' : ''}
       ${options.includeArchived ? '' : 'AND COALESCE(is_archived, 0) = 0'}
       AND (
       LOWER(title) LIKE ? OR LOWER(preview) LIKE ?
       OR id IN (SELECT DISTINCT session_id FROM ${MESSAGES_TABLE} WHERE LOWER(content) LIKE ? OR LOWER(COALESCE(tool_name, '')) LIKE ?)
     )
     ORDER BY last_active DESC LIMIT ?`,
  ).all(...[
    agentFilter,
    ...(userId ? [userId] : []),
    ...(options.source ? [options.source] : []),
    pattern,
    pattern,
    pattern,
    pattern,
    limit,
  ]) as Record<string, unknown>[]

  if (sessionRows.length === 0) return []
  const msgQuery = db.prepare(
    `SELECT id, content, tool_name FROM ${MESSAGES_TABLE}
     WHERE session_id = ? AND (LOWER(content) LIKE ? OR LOWER(COALESCE(tool_name, '')) LIKE ?)
     ORDER BY timestamp, id LIMIT 1`,
  )

  return sessionRows.map(row => {
    const session = mapSessionRow(row)
    let snippet = ''
    let matched_message_id: number | null = null
    const titleLower = (session.title || '').toLowerCase()
    const previewLower = (session.preview || '').toLowerCase()
    const titleIdx = titleLower.indexOf(lowered)
    const previewIdx = previewLower.indexOf(lowered)
    if (titleIdx >= 0) {
      snippet = session.title!.substring(Math.max(0, titleIdx - 20), titleIdx + lowered.length + 60)
    } else if (previewIdx >= 0) {
      snippet = session.preview.substring(Math.max(0, previewIdx - 20), previewIdx + lowered.length + 60)
    } else {
      const msg = msgQuery.get(session.id, pattern, pattern) as { id: number; content: string; tool_name: string | null } | undefined
      if (msg) {
        matched_message_id = msg.id
        const contentLower = msg.content.toLowerCase()
        const idx = contentLower.indexOf(lowered)
        snippet = msg.content.substring(Math.max(0, idx - 20), idx + lowered.length + 60)
      }
    }
    return { ...session, snippet, matched_message_id }
  })
}

export interface PaginatedSessionDetailResult {
  session: HermesSessionRow
  messages: HermesMessageRow[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
}

export function getSessionDetail(id: string): HermesSessionDetailRow | null {
  if (!isSqliteAvailable()) return null
  const db = getDb()!
  const sessionRow = db.prepare(`SELECT * FROM ${SESSIONS_TABLE} WHERE id = ?`).get(id) as Record<string, unknown> | undefined
  if (!sessionRow) return null
  const msgRows = db.prepare(
    `SELECT * FROM ${MESSAGES_TABLE} WHERE session_id = ? ORDER BY id`,
  ).all(id) as Record<string, unknown>[]
  const session = mapSessionRow(sessionRow)
  return {
    ...session,
    messages: msgRows.map(mapMessageRow),
    thread_session_count: 1,
  }
}

// --- Message CRUD ---

export function addMessage(msg: {
  session_id: string
  role: string
  content: string
  display_role?: string | null
  display_content?: string | null
  tool_call_id?: string | null
  tool_calls?: any[] | null
  tool_name?: string | null
  timestamp?: number
  token_count?: number | null
  finish_reason?: string | null
  reasoning?: string | null
  reasoning_details?: string | null
  reasoning_content?: string | null
  run_id?: string | null
  client_id?: string | null
}): number | undefined {
  if (!isSqliteAvailable()) return undefined
  const db = getDb()!
  const toolCallsJson = msg.tool_calls ? JSON.stringify(msg.tool_calls) : null
  const result = db.prepare(
    `INSERT INTO ${MESSAGES_TABLE} (session_id, role, content, display_role, display_content, tool_call_id, tool_calls, tool_name, timestamp, token_count, finish_reason, reasoning, reasoning_details, reasoning_content, run_id, client_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.session_id, msg.role, normalizeMessageContentForStorageRole(msg.role, msg.content),
    msg.display_role ?? null, msg.display_content ?? null,
    msg.tool_call_id ?? null, toolCallsJson, msg.tool_name ?? null,
    msg.timestamp ?? Math.floor(Date.now() / 1000),
    msg.token_count ?? null, msg.finish_reason ?? null,
    msg.reasoning ?? null, msg.reasoning_details ?? null,
    msg.reasoning_content ?? null, msg.run_id ?? '', msg.client_id ?? '',
  )
  return result.lastInsertRowid as number
}

export function addMessages(msgs: Array<{
  session_id: string
  role: string
  content: string
  display_role?: string | null
  display_content?: string | null
  tool_call_id?: string | null
  tool_calls?: any[] | null
  tool_name?: string | null
  timestamp?: number
  token_count?: number | null
  finish_reason?: string | null
  reasoning?: string | null
  reasoning_details?: string | null
  reasoning_content?: string | null
  run_id?: string | null
  client_id?: string | null
}>): void {
  if (!isSqliteAvailable() || msgs.length === 0) return
  const db = getDb()!
  const insert = db.prepare(
    `INSERT INTO ${MESSAGES_TABLE} (session_id, role, content, display_role, display_content, tool_call_id, tool_calls, tool_name, timestamp, token_count, finish_reason, reasoning, reasoning_details, reasoning_content, run_id, client_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  db.exec('BEGIN')
  try {
    for (const msg of msgs) {
      const toolCallsJson = msg.tool_calls ? JSON.stringify(msg.tool_calls) : null
      insert.run(
        msg.session_id, msg.role, normalizeMessageContentForStorageRole(msg.role, msg.content),
        msg.display_role ?? null, msg.display_content ?? null,
        msg.tool_call_id ?? null, toolCallsJson, msg.tool_name ?? null,
        msg.timestamp ?? Math.floor(Date.now() / 1000),
        msg.token_count ?? null, msg.finish_reason ?? null,
        msg.reasoning ?? null, msg.reasoning_details ?? null,
        msg.reasoning_content ?? null, msg.run_id ?? '', msg.client_id ?? '',
      )
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export function getMessageCount(sessionId: string): number {
  if (!isSqliteAvailable()) return 0
  const db = getDb()!
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM ${MESSAGES_TABLE} WHERE session_id = ?`,
  ).get(sessionId) as { cnt: number } | undefined
  return row?.cnt ?? 0
}

export function updateSessionStats(id: string): void {
  if (!isSqliteAvailable()) return
  const db = getDb()!
  db.prepare(
    `UPDATE ${SESSIONS_TABLE}
     SET message_count = (SELECT COUNT(*) FROM ${MESSAGES_TABLE} WHERE session_id = ?),
         last_active = COALESCE((SELECT MAX(timestamp) FROM ${MESSAGES_TABLE} WHERE session_id = ?), started_at)
     WHERE id = ?`,
  ).run(id, id, id)
  console.log(`Updated session ${id} stats`)
}

export function getSessionDetailPaginated(
  id: string,
  offset = 0,
  limit = 150,
): PaginatedSessionDetailResult | null {
  if (!isSqliteAvailable()) {
    return null
  }

  const db = getDb()!

  // Get session info
  const sessionRow = db.prepare(`SELECT * FROM ${SESSIONS_TABLE} WHERE id = ?`).get(id) as Record<string, unknown> | undefined
  if (!sessionRow) return null

  // Get total message count
  const countResult = db.prepare(
    `SELECT COUNT(*) as total FROM ${MESSAGES_TABLE} WHERE session_id = ?`,
  ).get(id) as { total: number } | undefined
  const total = countResult?.total || 0

  // Get paginated messages (newest first from DB, then reverse).
  // Timestamp precision is mixed across message sources; id is insertion order.
  const msgRows = db.prepare(
    `SELECT * FROM ${MESSAGES_TABLE} WHERE session_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
  ).all(id, limit, offset) as Record<string, unknown>[]

  const session = mapSessionRow(sessionRow)
  const messages = msgRows.map(mapMessageRow).reverse()  // Reverse to show oldest first

  return {
    session,
    messages,
    total,
    offset,
    limit,
    hasMore: offset + messages.length < total,
  }
}
