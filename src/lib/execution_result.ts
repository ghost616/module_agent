import { mkdir, unlink, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExecutionRecord, ExecutionRecords } from './types.ts'
import { exists, readJson, writeText } from './fs.ts'

function resultsDir(workspaceDir: string, moduleName: string): string {
  return join(workspaceDir, 'executions', moduleName)
}

function resultPath(workspaceDir: string, moduleName: string, sessionId: string): string {
  return join(resultsDir(workspaceDir, moduleName), `${sessionId}.json`)
}

export async function writeExecutionRecord(
  workspaceDir: string,
  moduleName: string,
  sessionId: string,
  record: ExecutionRecord,
): Promise<void> {
  const dir = resultsDir(workspaceDir, moduleName)
  await mkdir(dir, { recursive: true })
  const path = resultPath(workspaceDir, moduleName, sessionId)

  let records: ExecutionRecords = []
  if (await exists(path)) {
    try {
      records = await readJson<ExecutionRecords>(path)
    } catch {
      records = []
    }
  }

  if (records.length > 0) {
    const last = records[records.length - 1]
    if (last.status === 'success' || last.status === 'partial' || last.status === 'failed') {
      records.push(record)
    } else {
      records[records.length - 1] = record
    }
  } else {
    records.push(record)
  }

  await writeText(path, JSON.stringify(records, null, 2))
}

export async function readAndCleanExecutionRecords(
  workspaceDir: string,
  moduleName: string,
  sessionId: string,
): Promise<{ completed: ExecutionRecord[]; active: ExecutionRecord | null }> {
  const path = resultPath(workspaceDir, moduleName, sessionId)
  if (!(await exists(path))) return { completed: [], active: null }

  let records: ExecutionRecords
  try {
    records = await readJson<ExecutionRecords>(path)
  } catch {
    return { completed: [], active: null }
  }

  const completed = records.filter(
    (r) => r.status === 'success' || r.status === 'partial' || r.status === 'failed',
  )
  const activeRecords = records.filter(
    (r) => r.status === 'started' || r.status === 'running',
  )

  if (activeRecords.length > 0) {
    await writeText(path, JSON.stringify(activeRecords, null, 2))
  } else {
    await _deleteExecutionRecords(workspaceDir, moduleName, sessionId)
  }

  return {
    completed,
    active: activeRecords.length > 0 ? activeRecords[activeRecords.length - 1] : null,
  }
}

async function _deleteExecutionRecords(
  workspaceDir: string,
  moduleName: string,
  sessionId: string,
): Promise<boolean> {
  const path = resultPath(workspaceDir, moduleName, sessionId)
  if (!(await exists(path))) return false
  await unlink(path)
  return true
}

export async function deleteExecutionRecords(
  workspaceDir: string,
  moduleName: string,
  sessionId: string,
): Promise<boolean> {
  return _deleteExecutionRecords(workspaceDir, moduleName, sessionId)
}

export async function cleanStaleExecutions(
  workspaceDir: string,
  isAlive: (sessionId: string) => Promise<boolean>,
): Promise<number> {
  const root = join(workspaceDir, 'executions')
  if (!(await exists(root))) return 0
  let removed = 0
  const modules = await readdir(root, { withFileTypes: true })
  for (const m of modules) {
    if (!m.isDirectory()) continue
    const modDir = join(root, m.name)
    const files = await readdir(modDir)
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const sid = f.slice(0, -5)
      if (!(await isAlive(sid))) {
        await unlink(join(modDir, f))
        removed++
      }
    }
  }
  return removed
}
