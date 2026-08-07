import { join } from 'node:path'
import { exec } from 'node:child_process'
import { readdir, unlink } from 'node:fs/promises'
import { exists, writeText } from './fs.ts'

export interface ShellResult {
  stdout: string
  stderr: string
  exit_code: number
  duration_ms: number
}

export function runShellCommand(command: string, cwd: string, timeout: number, maxBuffer: number): Promise<ShellResult> {
  const startTime = Date.now()
  return new Promise((resolve) => {
    exec(command, { cwd, timeout, maxBuffer }, (error, stdout, stderr) => {
      const exitCode = error ? ((error as any).code ?? 1) : 0
      resolve({
        stdout: stdout.slice(0, maxBuffer),
        stderr: stderr.slice(0, maxBuffer),
        exit_code: exitCode,
        duration_ms: Date.now() - startTime,
      })
    })
  })
}

export async function writeTestReport(
  workspaceDir: string,
  sessionId: string,
  content: string,
): Promise<void> {
  const dir = join(workspaceDir, 'test_reports')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${sessionId}.json`)
  const record = {
    lizhu_session_id: sessionId,
    content,
    timestamp: new Date().toISOString(),
  }
  await writeText(path, JSON.stringify(record, null, 2))
}

export async function writeTestSpec(
  workspaceDir: string,
  sessionId: string,
  content: string,
): Promise<void> {
  const dir = join(workspaceDir, 'test_specs')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${sessionId}.json`)
  const record = {
    session_id: sessionId,
    content,
    timestamp: new Date().toISOString(),
  }
  await writeText(path, JSON.stringify(record, null, 2))
}

export async function cleanStaleTestSpecs(
  workspaceDir: string,
  isAlive: (sessionId: string) => Promise<boolean>,
): Promise<number> {
  const dir = join(workspaceDir, 'test_specs')
  if (!(await exists(dir))) return 0
  let removed = 0
  const files = await readdir(dir)
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const sid = f.slice(0, -5)
    if (!(await isAlive(sid))) {
      try { await unlink(join(dir, f)) } catch {}
      removed++
    }
  }
  return removed
}

export async function cleanStaleTestReports(
  workspaceDir: string,
  isAlive: (sessionId: string) => Promise<boolean>,
): Promise<number> {
  const dir = join(workspaceDir, 'test_reports')
  if (!(await exists(dir))) return 0
  let removed = 0
  const files = await readdir(dir)
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const sid = f.slice(0, -5)
    if (!(await isAlive(sid))) {
      try { await unlink(join(dir, f)) } catch {}
      removed++
    }
  }
  return removed
}
