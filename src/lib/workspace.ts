import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { WORKSPACE_INDEX_FILE, workspaceDir as wsDir } from './constants.ts'
import { exists, readJson, writeText } from './fs.ts'

export interface WorkspaceEntry {
  name: string
  created_at: string
}

interface WorkspaceIndex {
  workspaces: WorkspaceEntry[]
  bindings: Record<string, string>
}

const NAME_REGEX = /^[a-zA-Z0-9_]{1,50}$/

function indexPath(directory: string): string {
  return join(directory, WORKSPACE_INDEX_FILE)
}

async function readIndex(directory: string): Promise<WorkspaceIndex> {
  const path = indexPath(directory)
  if (!(await exists(path))) return { workspaces: [], bindings: {} }
  try {
    return await readJson<WorkspaceIndex>(path)
  } catch {
    return { workspaces: [], bindings: {} }
  }
}

async function writeIndex(directory: string, data: WorkspaceIndex): Promise<void> {
  const path = indexPath(directory)
  await mkdir(join(directory, '.module_agent', 'workspaces'), { recursive: true })
  await writeText(path, JSON.stringify(data, null, 2))
}

export async function listWorkspaces(directory: string): Promise<WorkspaceEntry[]> {
  const idx = await readIndex(directory)
  return idx.workspaces
}

export async function createWorkspace(directory: string, name: string): Promise<string> {
  if (!NAME_REGEX.test(name)) {
    throw new Error(`工作空间名称仅支持英文、数字、下划线，长度 1-50。`)
  }
  const idx = await readIndex(directory)
  if (idx.workspaces.some(w => w.name === name)) {
    throw new Error(`工作空间 '${name}' 已存在。`)
  }
  const dir = wsDir(directory, name)
  await mkdir(dir, { recursive: true })
  idx.workspaces.push({ name, created_at: new Date().toISOString() })
  await writeIndex(directory, idx)
  return name
}

export async function bindFengzhou(directory: string, fengzhouSessionId: string, workspaceName: string): Promise<void> {
  const idx = await readIndex(directory)
  if (!idx.workspaces.some(w => w.name === workspaceName)) {
    throw new Error(`工作空间 '${workspaceName}' 不存在。`)
  }
  if (idx.bindings[fengzhouSessionId]) {
    throw new Error('当前风后已绑定工作空间，不可修改。')
  }
  idx.bindings[fengzhouSessionId] = workspaceName
  await writeIndex(directory, idx)
}

export async function getBoundWorkspace(directory: string, fengzhouSessionId: string): Promise<string | null> {
  const idx = await readIndex(directory)
  return idx.bindings[fengzhouSessionId] ?? null
}

export function getWorkspaceDir(directory: string, workspaceName: string): string {
  return wsDir(directory, workspaceName)
}

export async function resolveWorkspace(directory: string, sessionId: string): Promise<string | null> {
  // First try fengzhou binding
  const bound = await getBoundWorkspace(directory, sessionId)
  if (bound) return bound

  // Then try limu/gaotao session mapping
  const { getSessionWorkspace } = await import('./session_workspace.ts')
  return getSessionWorkspace(directory, sessionId)
}
