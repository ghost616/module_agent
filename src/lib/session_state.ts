import { mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { SESSION_MODES_FILE } from './constants.ts'
import { exists, readJson, writeText } from './fs.ts'

export type AgentMode = 'fengzhou' | 'qibo' | 'limu' | 'gaotao' | 'lishou'

type AgentModeMap = Map<string, AgentMode>
const sessions = new Map<string, AgentModeMap>()

function sessionModesPath(directory: string): string {
  return join(directory, SESSION_MODES_FILE)
}

function getOrCreateMap(directory: string): AgentModeMap {
  let map = sessions.get(directory)
  if (!map) {
    map = new Map<string, AgentMode>()
    sessions.set(directory, map)
  }
  return map
}

function persistAsync(directory: string): void {
  const map = sessions.get(directory)
  if (!map) return
  const obj: Record<string, string> = {}
  for (const [key, value] of map) {
    obj[key] = value
  }
  const path = sessionModesPath(directory)
  mkdir(dirname(path), { recursive: true })
    .then(() => writeText(path, JSON.stringify(obj)))
    .catch(() => {})
}

export async function initSessionState(directory: string): Promise<void> {
  if (!sessions.has(directory)) {
    const map = new Map<string, AgentMode>()
    const path = sessionModesPath(directory)
    if (await exists(path)) {
      const data = await readJson<Record<string, string>>(path)
      for (const [key, value] of Object.entries(data)) {
        map.set(key, value as AgentMode)
      }
    }
    sessions.set(directory, map)
  }
}

export function getAgentMode(directory: string, sessionID: string): AgentMode | undefined {
  return getOrCreateMap(directory).get(sessionID)
}

export function setAgentMode(directory: string, sessionID: string, mode: AgentMode): void {
  getOrCreateMap(directory).set(sessionID, mode)
  persistAsync(directory)
}

export function clearAgentMode(directory: string, sessionID: string): void {
  getOrCreateMap(directory).delete(sessionID)
  persistAsync(directory)
}

export async function cleanStaleAgentModes(
  directory: string,
  isAlive: (sessionId: string) => Promise<boolean>,
): Promise<number> {
  const map = getOrCreateMap(directory)
  let removed = 0
  for (const sid of [...map.keys()]) {
    if (!(await isAlive(sid))) {
      map.delete(sid)
      removed++
    }
  }
  if (removed > 0) {
    const obj: Record<string, string> = {}
    for (const [key, value] of map) {
      obj[key] = value
    }
    const path = sessionModesPath(directory)
    await mkdir(dirname(path), { recursive: true })
    await writeText(path, JSON.stringify(obj))
  }
  return removed
}
