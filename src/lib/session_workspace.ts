import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { SESSION_WORKSPACE_FILE } from './constants.ts'
import { exists, readJson, writeText } from './fs.ts'

type SessionWorkspaceMap = Record<string, string>

function filePath(directory: string): string {
  return join(directory, SESSION_WORKSPACE_FILE)
}

async function readMap(directory: string): Promise<SessionWorkspaceMap> {
  const path = filePath(directory)
  if (!(await exists(path))) return {}
  try {
    return await readJson<SessionWorkspaceMap>(path)
  } catch {
    return {}
  }
}

async function writeMap(directory: string, data: SessionWorkspaceMap): Promise<void> {
  const path = filePath(directory)
  await mkdir(join(directory, '.module_agent'), { recursive: true })
  await writeText(path, JSON.stringify(data, null, 2))
}

export async function setSessionWorkspace(directory: string, sessionId: string, workspaceName: string): Promise<void> {
  const data = await readMap(directory)
  data[sessionId] = workspaceName
  await writeMap(directory, data)
}

export async function getSessionWorkspace(directory: string, sessionId: string): Promise<string | null> {
  const data = await readMap(directory)
  return data[sessionId] ?? null
}

export async function removeSessionWorkspace(directory: string, sessionId: string): Promise<void> {
  const data = await readMap(directory)
  if (!(sessionId in data)) return
  delete data[sessionId]
  await writeMap(directory, data)
}
