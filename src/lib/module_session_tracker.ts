import { mkdir, rm } from 'node:fs/promises'
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
  await unbindLimuStarter(workspaceDir, sessionId)

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

export async function getModuleNameBySession(workspaceDir: string, sessionId: string): Promise<string | null> {
  const data = await readSessions(workspaceDir)
  for (const [moduleName, sids] of Object.entries(data)) {
    if (moduleName === '_checked') continue
    if (sids.includes(sessionId)) return moduleName
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
// 统一会话绑定存储（session_bindings.json）
// - gaotao: 风后 sid → 皋陶 sid
// - limu:   力牧 sid → 风后 sid
// - lizhu:  启动者 sid → 离朱 sid
// - lizhu_fengzhou: 离朱 sid → 风后 sid
// ============================================================

interface SessionBindings {
  gaotao: Record<string, string>
  limu: Record<string, string>
  lizhu: Record<string, string>
  lizhu_fengzhou: Record<string, string>
}

const LEGACY_FILES: Array<{ key: keyof SessionBindings; file: string }> = [
  { key: 'gaotao', file: 'fengzhou_gaotao_map.json' },
  { key: 'limu', file: 'limu_starter_map.json' },
  { key: 'lizhu', file: 'lizhu_map.json' },
]

function bindingsPath(workspaceDir: string): string {
  return join(workspaceDir, 'session_bindings.json')
}

async function readBindings(workspaceDir: string): Promise<SessionBindings> {
  const path = bindingsPath(workspaceDir)
  if (await exists(path)) {
    const data = await readJson<Partial<SessionBindings>>(path)
    return { gaotao: data.gaotao ?? {}, limu: data.limu ?? {}, lizhu: data.lizhu ?? {}, lizhu_fengzhou: data.lizhu_fengzhou ?? {} }
  }

  const bindings: SessionBindings = { gaotao: {}, limu: {}, lizhu: {}, lizhu_fengzhou: {} }
  for (const { key, file } of LEGACY_FILES) {
    const legacyPath = join(workspaceDir, file)
    if (await exists(legacyPath)) {
      try {
        bindings[key] = await readJson<Record<string, string>>(legacyPath)
      } catch {
        // ignore corrupt legacy file
      }
    }
  }
  return bindings
}

async function writeBindings(workspaceDir: string, data: SessionBindings): Promise<void> {
  const path = bindingsPath(workspaceDir)
  await mkdir(dirname(path), { recursive: true })
  await writeText(path, JSON.stringify(data, null, 2))
  for (const { file } of LEGACY_FILES) {
    await rm(join(workspaceDir, file), { force: true }).catch(() => {})
  }
}

// ============================================================
// 风后 ↔ 皋陶 会话绑定（在 workspace 内）
// ============================================================

export async function bindGaotao(workspaceDir: string, fengzhouSessionId: string, gaotaoSessionId: string): Promise<void> {
  const data = await readBindings(workspaceDir)
  data.gaotao[fengzhouSessionId] = gaotaoSessionId
  await writeBindings(workspaceDir, data)
}

export async function unbindGaotao(workspaceDir: string, fengzhouSessionId: string): Promise<void> {
  const data = await readBindings(workspaceDir)
  if (!(fengzhouSessionId in data.gaotao)) return
  delete data.gaotao[fengzhouSessionId]
  await writeBindings(workspaceDir, data)
}

export async function getBoundGaotao(workspaceDir: string, fengzhouSessionId: string, client: OpencodeClient): Promise<string | null> {
  const data = await readBindings(workspaceDir)
  const sid = data.gaotao[fengzhouSessionId]
  if (!sid) return null

  try {
    const sessionResult = await client.session.get({ path: { id: sid } })
    if (!sessionResult || sessionResult.error) {
      delete data.gaotao[fengzhouSessionId]
      await writeBindings(workspaceDir, data)
      clearAgentMode(workspaceDir, sid)
      return null
    }
    return sid
  } catch {
    delete data.gaotao[fengzhouSessionId]
    await writeBindings(workspaceDir, data)
    clearAgentMode(workspaceDir, sid)
    return null
  }
}

export async function isGaotaoBoundToFengzhou(
  workspaceDir: string,
  fengzhouSessionId: string,
  gaotaoSessionId: string,
): Promise<boolean> {
  const data = await readBindings(workspaceDir)
  return data.gaotao[fengzhouSessionId] === gaotaoSessionId
}

export async function getGaotaoStarter(workspaceDir: string, gaotaoSessionId: string): Promise<string | null> {
  const data = await readBindings(workspaceDir)
  for (const [fsid, gsid] of Object.entries(data.gaotao)) {
    if (gsid === gaotaoSessionId) return fsid
  }
  return null
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
  const data = await readBindings(workspaceDir)
  let removed = 0
  for (const [fsid, gsid] of Object.entries(data.gaotao)) {
    if (!(await isAlive(fsid)) || !(await isAlive(gsid))) {
      delete data.gaotao[fsid]
      removed++
    }
  }
  if (removed > 0) await writeBindings(workspaceDir, data)
  return removed
}

// ============================================================
// 风后 ↔ 力牧 会话绑定（在 workspace 内）
// ============================================================

export async function bindLimuStarter(workspaceDir: string, fengzhouSessionId: string, limuSessionId: string): Promise<void> {
  const data = await readBindings(workspaceDir)
  data.limu[limuSessionId] = fengzhouSessionId
  await writeBindings(workspaceDir, data)
}

export async function unbindLimuStarter(workspaceDir: string, limuSessionId: string): Promise<void> {
  const data = await readBindings(workspaceDir)
  if (!(limuSessionId in data.limu)) return
  delete data.limu[limuSessionId]
  await writeBindings(workspaceDir, data)
}

export async function getLimuStarter(workspaceDir: string, limuSessionId: string): Promise<string | null> {
  const data = await readBindings(workspaceDir)
  return data.limu[limuSessionId] ?? null
}

export async function getFengzhouLimuSessions(workspaceDir: string, fengzhouSessionId: string): Promise<string[]> {
  const data = await readBindings(workspaceDir)
  return Object.entries(data.limu)
    .filter(([, fsid]) => fsid === fengzhouSessionId)
    .map(([lsid]) => lsid)
}

export async function isLimuBoundToFengzhou(
  workspaceDir: string,
  fengzhouSessionId: string,
  limuSessionId: string,
): Promise<boolean> {
  const data = await readBindings(workspaceDir)
  return data.limu[limuSessionId] === fengzhouSessionId
}

export async function cleanStaleLimuMap(
  workspaceDir: string,
  isAlive: (sessionId: string) => Promise<boolean>,
): Promise<number> {
  const data = await readBindings(workspaceDir)
  let removed = 0
  for (const [lsid, fsid] of Object.entries(data.limu)) {
    if (!(await isAlive(lsid)) || !(await isAlive(fsid))) {
      delete data.limu[lsid]
      removed++
    }
  }
  if (removed > 0) await writeBindings(workspaceDir, data)
  return removed
}

// ============================================================
// 离朱会话绑定（starter → 离朱）
// ============================================================

export async function bindLizhu(workspaceDir: string, starterSessionId: string, lizhuSessionId: string): Promise<void> {
  const data = await readBindings(workspaceDir)
  data.lizhu[starterSessionId] = lizhuSessionId
  await writeBindings(workspaceDir, data)
}

export async function unbindLizhu(workspaceDir: string, starterSessionId: string): Promise<void> {
  const data = await readBindings(workspaceDir)
  if (!(starterSessionId in data.lizhu)) return
  delete data.lizhu[starterSessionId]
  await writeBindings(workspaceDir, data)
}

export async function getBoundLizhu(workspaceDir: string, starterSessionId: string): Promise<string | null> {
  const data = await readBindings(workspaceDir)
  return data.lizhu[starterSessionId] ?? null
}

export async function getBoundStarter(workspaceDir: string, lizhuSessionId: string): Promise<string | null> {
  const data = await readBindings(workspaceDir)
  for (const [starter, lizhu] of Object.entries(data.lizhu)) {
    if (lizhu === lizhuSessionId) return starter
  }
  return null
}

// ============================================================
// 离朱 ↔ 风后 会话绑定（力牧新开离朱时绑定所属风后）
// ============================================================

export async function bindLizhuFengzhou(workspaceDir: string, lizhuSessionId: string, fengzhouSessionId: string): Promise<void> {
  const data = await readBindings(workspaceDir)
  data.lizhu_fengzhou[lizhuSessionId] = fengzhouSessionId
  await writeBindings(workspaceDir, data)
}

export async function unbindLizhuFengzhou(workspaceDir: string, lizhuSessionId: string): Promise<void> {
  const data = await readBindings(workspaceDir)
  if (!(lizhuSessionId in data.lizhu_fengzhou)) return
  delete data.lizhu_fengzhou[lizhuSessionId]
  await writeBindings(workspaceDir, data)
}

export async function getLizhuFengzhou(workspaceDir: string, lizhuSessionId: string): Promise<string | null> {
  const data = await readBindings(workspaceDir)
  return data.lizhu_fengzhou[lizhuSessionId] ?? null
}

export async function getFengzhouLizhuSessions(workspaceDir: string, fengzhouSessionId: string): Promise<string[]> {
  const data = await readBindings(workspaceDir)
  const result = new Set<string>()

  const direct = data.lizhu[fengzhouSessionId]
  if (direct) result.add(direct)

  for (const [limuSid, fsid] of Object.entries(data.limu)) {
    if (fsid !== fengzhouSessionId) continue
    const lizhuSid = data.lizhu[limuSid]
    if (lizhuSid) result.add(lizhuSid)
  }

  for (const [lizhuSid, fsid] of Object.entries(data.lizhu_fengzhou)) {
    if (fsid === fengzhouSessionId) result.add(lizhuSid)
  }

  return [...result]
}

export async function cleanStaleLizhuFengzhouMap(
  workspaceDir: string,
  isAlive: (sessionId: string) => Promise<boolean>,
): Promise<number> {
  const data = await readBindings(workspaceDir)
  let removed = 0
  for (const [lsid, fsid] of Object.entries(data.lizhu_fengzhou)) {
    if (!(await isAlive(lsid)) || !(await isAlive(fsid))) {
      delete data.lizhu_fengzhou[lsid]
      removed++
    }
  }
  if (removed > 0) await writeBindings(workspaceDir, data)
  return removed
}

export async function getAvailableLizhuSession(workspaceDir: string, client: OpencodeClient): Promise<string | null> {
  const data = await readBindings(workspaceDir)
  const boundSet = new Set(Object.values(data.lizhu))

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
  const data = await readBindings(workspaceDir)
  const boundSet = new Set(Object.values(data.lizhu))
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
  await unbindLizhuFengzhou(workspaceDir, sessionId)

  const sessions = await readLizhuSessions(workspaceDir)
  const filtered = sessions.filter(s => s !== sessionId)
  await writeLizhuSessions(workspaceDir, filtered)
}

export async function cleanStaleLizhuMap(
  workspaceDir: string,
  isAlive: (sessionId: string) => Promise<boolean>,
): Promise<number> {
  const data = await readBindings(workspaceDir)
  let removed = 0
  for (const [ssid, lsid] of Object.entries(data.lizhu)) {
    if (!(await isAlive(ssid)) || !(await isAlive(lsid))) {
      delete data.lizhu[ssid]
      removed++
    }
  }
  if (removed > 0) await writeBindings(workspaceDir, data)
  return removed
}
