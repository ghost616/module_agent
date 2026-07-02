import { mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { OpencodeClient } from '@opencode-ai/sdk'
import { clearAgentMode } from './session_state.ts'
import { isWorking } from './limu_monitor.ts'
import { exists, readJson, writeText } from './fs.ts'

function filePath(workspaceDir: string): string {
  return join(workspaceDir, 'module_sessions.json')
}

async function readSessions(workspaceDir: string): Promise<Record<string, string[]>> {
  const path = filePath(workspaceDir)
  if (!(await exists(path))) return {}
  return readJson<Record<string, string[]>>(path)
}

async function writeSessions(workspaceDir: string, data: Record<string, string[]>): Promise<void> {
  const path = filePath(workspaceDir)
  await mkdir(dirname(path), { recursive: true })
  await writeText(path, JSON.stringify(data, null, 2))
}

export async function addModuleSession(workspaceDir: string, moduleName: string, sessionId: string): Promise<void> {
  const data = await readSessions(workspaceDir)
  if (!data[moduleName]) data[moduleName] = []
  if (!data[moduleName].includes(sessionId)) {
    data[moduleName].push(sessionId)
  }
  await writeSessions(workspaceDir, data)
}

export async function removeModuleSession(workspaceDir: string, moduleName: string, sessionId: string): Promise<void> {
  await unbindLizhu(workspaceDir, sessionId)

  const data = await readSessions(workspaceDir)
  if (!data[moduleName]) return
  data[moduleName] = data[moduleName].filter((s) => s !== sessionId)
  if (data[moduleName].length === 0) delete data[moduleName]
  await writeSessions(workspaceDir, data)
}

export async function getModuleLimuSession(
  workspaceDir: string,
  moduleName: string,
  client: OpencodeClient,
): Promise<string | null> {
  const data = await readSessions(workspaceDir)
  const sessionIds = data[moduleName]
  if (!sessionIds || sessionIds.length === 0) return null

  for (const sid of sessionIds) {
    try {
      const sessionResult = await client.session.get({ path: { id: sid } })
      if (!sessionResult || sessionResult.error) {
        await removeModuleSession(workspaceDir, moduleName, sid)
        clearAgentMode(workspaceDir, sid)
        continue
      }
      if (isWorking(sid)) continue
      return sid
    } catch {
      await removeModuleSession(workspaceDir, moduleName, sid)
      clearAgentMode(workspaceDir, sid)
      continue
    }
  }

  return null
}

export async function markSessionChecked(workspaceDir: string, sessionId: string): Promise<void> {
  const data = await readSessions(workspaceDir)
  if (!data._checked) data._checked = []
  if (!data._checked.includes(sessionId)) {
    data._checked.push(sessionId)
  }
  await writeSessions(workspaceDir, data)
}

export async function isSessionChecked(workspaceDir: string, sessionId: string): Promise<boolean> {
  const data = await readSessions(workspaceDir)
  return data._checked ? data._checked.includes(sessionId) : false
}

export async function clearSessionChecked(workspaceDir: string, sessionId: string): Promise<void> {
  const data = await readSessions(workspaceDir)
  if (!data._checked) return
  data._checked = data._checked.filter((s) => s !== sessionId)
  if (data._checked.length === 0) delete data._checked
  await writeSessions(workspaceDir, data)
}

// ============================================================
// 风后 ↔ 皋陶 会话绑定（在 workspace 内）
// ============================================================

function gaotaoMapPath(workspaceDir: string): string {
  return join(workspaceDir, 'fengzhou_gaotao_map.json')
}

async function readGaotaoMap(workspaceDir: string): Promise<Record<string, string>> {
  const path = gaotaoMapPath(workspaceDir)
  if (!(await exists(path))) return {}
  return readJson<Record<string, string>>(path)
}

async function writeGaotaoMap(workspaceDir: string, data: Record<string, string>): Promise<void> {
  const path = gaotaoMapPath(workspaceDir)
  await mkdir(dirname(path), { recursive: true })
  await writeText(path, JSON.stringify(data, null, 2))
}

export async function bindGaotao(workspaceDir: string, fengzhouSessionId: string, gaotaoSessionId: string): Promise<void> {
  const data = await readGaotaoMap(workspaceDir)
  data[fengzhouSessionId] = gaotaoSessionId
  await writeGaotaoMap(workspaceDir, data)
}

export async function unbindGaotao(workspaceDir: string, fengzhouSessionId: string): Promise<void> {
  const data = await readGaotaoMap(workspaceDir)
  if (!(fengzhouSessionId in data)) return
  delete data[fengzhouSessionId]
  await writeGaotaoMap(workspaceDir, data)
}

export async function getBoundGaotao(workspaceDir: string, fengzhouSessionId: string, client: OpencodeClient): Promise<string | null> {
  const data = await readGaotaoMap(workspaceDir)
  const sid = data[fengzhouSessionId]
  if (!sid) return null

  try {
    const sessionResult = await client.session.get({ path: { id: sid } })
    if (!sessionResult || sessionResult.error) {
      delete data[fengzhouSessionId]
      await writeGaotaoMap(workspaceDir, data)
      clearAgentMode(workspaceDir, sid)
      return null
    }
    return sid
  } catch {
    delete data[fengzhouSessionId]
    await writeGaotaoMap(workspaceDir, data)
    clearAgentMode(workspaceDir, sid)
    return null
  }
}

export async function isGaotaoBoundToFengzhou(
  workspaceDir: string,
  fengzhouSessionId: string,
  gaotaoSessionId: string,
): Promise<boolean> {
  const data = await readGaotaoMap(workspaceDir)
  return data[fengzhouSessionId] === gaotaoSessionId
}

export async function cleanStaleModuleSessions(
  workspaceDir: string,
  isAlive: (sessionId: string) => Promise<boolean>,
): Promise<number> {
  const data = await readSessions(workspaceDir)
  let removed = 0
  for (const key of Object.keys(data)) {
    const kept: string[] = []
    for (const sid of data[key]) {
      if (await isAlive(sid)) kept.push(sid)
      else removed++
    }
    if (kept.length === 0) delete data[key]
    else data[key] = kept
  }
  if (removed > 0) await writeSessions(workspaceDir, data)
  return removed
}

export async function cleanStaleGaotaoMap(
  workspaceDir: string,
  isAlive: (sessionId: string) => Promise<boolean>,
): Promise<number> {
  const data = await readGaotaoMap(workspaceDir)
  let removed = 0
  for (const [fsid, gsid] of Object.entries(data)) {
    if (!(await isAlive(fsid)) || !(await isAlive(gsid))) {
      delete data[fsid]
      removed++
    }
  }
  if (removed > 0) await writeGaotaoMap(workspaceDir, data)
  return removed
}

// ============================================================
// 离朱会话绑定（starter → 离朱）
// ============================================================

function lizhuMapPath(workspaceDir: string): string {
  return join(workspaceDir, 'lizhu_map.json')
}

async function readLizhuMap(workspaceDir: string): Promise<Record<string, string>> {
  const path = lizhuMapPath(workspaceDir)
  if (!(await exists(path))) return {}
  return readJson<Record<string, string>>(path)
}

async function writeLizhuMap(workspaceDir: string, data: Record<string, string>): Promise<void> {
  const path = lizhuMapPath(workspaceDir)
  await mkdir(dirname(path), { recursive: true })
  await writeText(path, JSON.stringify(data, null, 2))
}

export async function bindLizhu(workspaceDir: string, starterSessionId: string, lizhuSessionId: string): Promise<void> {
  const data = await readLizhuMap(workspaceDir)
  data[starterSessionId] = lizhuSessionId
  await writeLizhuMap(workspaceDir, data)
}

export async function unbindLizhu(workspaceDir: string, starterSessionId: string): Promise<void> {
  const data = await readLizhuMap(workspaceDir)
  if (!(starterSessionId in data)) return
  delete data[starterSessionId]
  await writeLizhuMap(workspaceDir, data)
}

export async function getBoundLizhu(workspaceDir: string, starterSessionId: string): Promise<string | null> {
  const data = await readLizhuMap(workspaceDir)
  return data[starterSessionId] ?? null
}

export async function getBoundStarter(workspaceDir: string, lizhuSessionId: string): Promise<string | null> {
  const data = await readLizhuMap(workspaceDir)
  for (const [starter, lizhu] of Object.entries(data)) {
    if (lizhu === lizhuSessionId) return starter
  }
  return null
}

export async function getAvailableLizhuSession(workspaceDir: string, client: OpencodeClient): Promise<string | null> {
  const map = await readLizhuMap(workspaceDir)
  const boundSet = new Set(Object.values(map))

  const sessions = await readLizhuSessions(workspaceDir)
  for (const sid of sessions) {
    if (boundSet.has(sid)) continue

    try {
      const sessionResult = await client.session.get({ path: { id: sid } })
      if (!sessionResult || sessionResult.error) {
        await removeLizhuSession(workspaceDir, sid)
        clearAgentMode(workspaceDir, sid)
        continue
      }
      if (isWorking(sid)) continue
      return sid
    } catch {
      await removeLizhuSession(workspaceDir, sid)
      clearAgentMode(workspaceDir, sid)
      continue
    }
  }

  return null
}

export async function getAllUnboundLizhuSessions(workspaceDir: string): Promise<string[]> {
  const map = await readLizhuMap(workspaceDir)
  const boundSet = new Set(Object.values(map))
  const sessions = await readLizhuSessions(workspaceDir)
  return sessions.filter(sid => !boundSet.has(sid))
}

function lizhuSessionsPath(workspaceDir: string): string {
  return join(workspaceDir, 'lizhu_sessions.json')
}

async function readLizhuSessions(workspaceDir: string): Promise<string[]> {
  const path = lizhuSessionsPath(workspaceDir)
  if (!(await exists(path))) return []
  try {
    return await readJson<string[]>(path)
  } catch {
    return []
  }
}

async function writeLizhuSessions(workspaceDir: string, data: string[]): Promise<void> {
  const path = lizhuSessionsPath(workspaceDir)
  await mkdir(dirname(path), { recursive: true })
  await writeText(path, JSON.stringify(data, null, 2))
}

export async function addLizhuSession(workspaceDir: string, sessionId: string): Promise<void> {
  const sessions = await readLizhuSessions(workspaceDir)
  if (!sessions.includes(sessionId)) {
    sessions.push(sessionId)
  }
  await writeLizhuSessions(workspaceDir, sessions)
}

export async function removeLizhuSession(workspaceDir: string, sessionId: string): Promise<void> {
  const starter = await getBoundStarter(workspaceDir, sessionId)
  if (starter) await unbindLizhu(workspaceDir, starter)

  const sessions = await readLizhuSessions(workspaceDir)
  const filtered = sessions.filter(s => s !== sessionId)
  await writeLizhuSessions(workspaceDir, filtered)
}

export async function cleanStaleLizhuMap(
  workspaceDir: string,
  isAlive: (sessionId: string) => Promise<boolean>,
): Promise<number> {
  const data = await readLizhuMap(workspaceDir)
  let removed = 0
  for (const [ssid, lsid] of Object.entries(data)) {
    if (!(await isAlive(ssid)) || !(await isAlive(lsid))) {
      delete data[ssid]
      removed++
    }
  }
  if (removed > 0) await writeLizhuMap(workspaceDir, data)
  return removed
}
