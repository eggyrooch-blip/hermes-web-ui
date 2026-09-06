import { request } from '../client'

export interface CoworkProject {
  id: string
  name: string
  description: string
  instructions: string
  icon: string
  color: string
  primary_folder: string | null
  status: 'active' | 'archived'
  created_at: number
  updated_at: number
}

export interface ProjectContextReceipt {
  session_id: string
  project_id: string | null
  project_name: string | null
  workspace: string | null
  instructions_fingerprint: string
  memory_enabled: boolean
  session_search_enabled: boolean
  folder_bound: boolean | null
}

export interface CoworkProjectSession {
  session_id: string
  created_at: number
}

export async function listCoworkProjects(query = ''): Promise<CoworkProject[]> {
  const result = await request<{ items: CoworkProject[] }>('/api/hermes/cowork/projects')
  const search = query.trim().toLowerCase()
  return search ? result.items.filter(project => `${project.name} ${project.description}`.toLowerCase().includes(search)) : result.items
}

export async function getCoworkProject(projectId: string): Promise<CoworkProject> {
  const result = await request<{ project: CoworkProject }>(`/api/hermes/cowork/projects/${encodeURIComponent(projectId)}`)
  return result.project
}

export async function listCoworkProjectSessions(projectId: string): Promise<CoworkProjectSession[]> {
  const result = await request<{ items: CoworkProjectSession[] }>(`/api/hermes/cowork/projects/${encodeURIComponent(projectId)}/sessions`)
  return result.items
}

export async function createCoworkProject(input: Pick<CoworkProject, 'name'> & Partial<Pick<CoworkProject, 'description' | 'instructions' | 'icon' | 'color' | 'primary_folder'>>): Promise<CoworkProject> {
  const result = await request<{ project: CoworkProject }>('/api/hermes/cowork/projects', { method: 'POST', body: JSON.stringify(input) })
  return result.project
}

export async function updateCoworkProject(projectId: string, input: Partial<Pick<CoworkProject, 'name' | 'description' | 'instructions' | 'icon' | 'color' | 'primary_folder'>>): Promise<CoworkProject> {
  const result = await request<{ project: CoworkProject }>(`/api/hermes/cowork/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: JSON.stringify(input) })
  return result.project
}

export async function archiveCoworkProject(projectId: string): Promise<CoworkProject> {
  const result = await request<{ project: CoworkProject }>(`/api/hermes/cowork/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' })
  return result.project
}

export async function getSessionProjectReceipt(sessionId: string): Promise<ProjectContextReceipt> {
  const result = await request<{ receipt: ProjectContextReceipt }>(`/api/hermes/cowork/sessions/${encodeURIComponent(sessionId)}/project`)
  return result.receipt
}
