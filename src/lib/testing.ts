import { join } from 'node:path'
import { readdir, unlink, rmdir } from 'node:fs/promises'
import { exec } from 'node:child_process'
import { writeText, readJson, exists } from './fs.ts'
import type { TestResult, AssertionResult, AssertionFailure } from './types.ts'

const SHORT_FIELD_LENGTH = 10 * 1024

export interface ShellResult {
  stdout: string
  stderr: string
  exit_code: number
  duration_ms: number
}

export interface HttpResult {
  status_code: number
  headers: Record<string, string>
  body: string
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

export async function runHttpRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: any,
  timeout: number,
): Promise<HttpResult> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  const fetchHeaders: Record<string, string> = { ...headers }

  const fetchOptions: RequestInit = {
    method,
    headers: fetchHeaders,
    signal: controller.signal,
  }

  if (body !== undefined && body !== null) {
    if (typeof body === 'object') {
      fetchOptions.body = JSON.stringify(body)
      if (!fetchHeaders['Content-Type'] && !fetchHeaders['content-type']) {
        fetchHeaders['Content-Type'] = 'application/json'
      }
    } else {
      fetchOptions.body = String(body)
    }
  }

  const startTime = Date.now()
  let response: Response

  try {
    response = await fetch(url, fetchOptions)
  } finally {
    clearTimeout(timeoutId)
  }

  const responseBody = await response.text()
  const duration_ms = Date.now() - startTime

  const responseHeaders: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value
  })

  return {
    status_code: response.status,
    headers: responseHeaders,
    body: responseBody,
    duration_ms,
  }
}

export function runAssertions(
  response: HttpResult,
  expectedStatus?: number,
  expectedBodyContains?: string,
  expectedHeaders?: Record<string, string>,
): AssertionResult {
  const result: AssertionResult = { passed: 0, failed: 0, failures: [] }

  if (expectedStatus !== undefined) {
    if (response.status_code === expectedStatus) {
      result.passed++
    } else {
      result.failed++
      result.failures.push({
        type: 'status',
        expected: expectedStatus,
        actual: response.status_code,
      })
    }
  }

  if (expectedBodyContains !== undefined) {
    if (response.body.includes(expectedBodyContains)) {
      result.passed++
    } else {
      result.failed++
      result.failures.push({
        type: 'body_contains',
        expected: expectedBodyContains,
        actual: response.body.slice(0, 200),
      })
    }
  }

  if (expectedHeaders) {
    for (const [key, expectedValue] of Object.entries(expectedHeaders)) {
      const actualValue = response.headers[key.toLowerCase()]
      if (actualValue === expectedValue) {
        result.passed++
      } else {
        result.failed++
        result.failures.push({
          type: 'header',
          key,
          expected: expectedValue,
          actual: actualValue || '(missing)',
        })
      }
    }
  }

  return result
}

export async function writeTestResult(
  workspaceDir: string,
  action: string,
  sessionId: string,
  result: TestResult,
): Promise<void> {
  const dir = join(workspaceDir, 'test_results', action)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${sessionId}.json`)

  let results: TestResult[] = []
  if (await exists(path)) {
    try {
      const existing = await readJson<TestResult[]>(path)
      results = Array.isArray(existing) ? existing : []
    } catch {}
  }
  results.push(result)
  await writeText(path, JSON.stringify(results, null, 2))
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
  await deleteTestResults(workspaceDir, sessionId)
}

export async function deleteTestResults(workspaceDir: string, sessionId: string): Promise<void> {
  const actions = ['interface']
  const { unlink } = await import('node:fs/promises')
  for (const action of actions) {
    const path = join(workspaceDir, 'test_results', action, `${sessionId}.json`)
    if (await exists(path)) {
      try { await unlink(path) } catch {}
    }
  }
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

export interface TestDataCleanupStats {
  test_reports: number
  test_results: number
  test_specs: number
}

export async function cleanStaleTestData(
  workspaceDir: string,
  isAlive: (sessionId: string) => Promise<boolean>,
): Promise<TestDataCleanupStats> {
  const stats: TestDataCleanupStats = { test_reports: 0, test_results: 0, test_specs: 0 }

  // 清理 test_reports/
  const reportsDir = join(workspaceDir, 'test_reports')
  if (await exists(reportsDir)) {
    try {
      const files = await readdir(reportsDir)
      for (const f of files) {
        if (!f.endsWith('.json')) continue
        const sessionId = f.slice(0, -5)
        if (!(await isAlive(sessionId))) {
          try { await unlink(join(reportsDir, f)) } catch {}
          stats.test_reports++
        }
      }
    } catch {}
  }

  // 清理 test_results/
  const resultsDir = join(workspaceDir, 'test_results')
  if (await exists(resultsDir)) {
    try {
      const actions = await readdir(resultsDir)
      for (const action of actions) {
        const actionDir = join(resultsDir, action)
        try {
          const files = await readdir(actionDir)
          let dirEmpty = true
          for (const f of files) {
            if (!f.endsWith('.json')) continue
            const sessionId = f.slice(0, -5)
            if (!(await isAlive(sessionId))) {
              try { await unlink(join(actionDir, f)) } catch {}
              stats.test_results++
            } else {
              dirEmpty = false
            }
          }
          if (dirEmpty) {
            try { await rmdir(actionDir) } catch {}
          }
        } catch {}
      }
    } catch {}
  }

  // 清理 test_specs/
  const specsDir = join(workspaceDir, 'test_specs')
  if (await exists(specsDir)) {
    try {
      const files = await readdir(specsDir)
      for (const f of files) {
        if (!f.endsWith('.json')) continue
        const sessionId = f.slice(0, -5)
        if (!(await isAlive(sessionId))) {
          try { await unlink(join(specsDir, f)) } catch {}
          stats.test_specs++
        }
      }
    } catch {}
  }

  return stats
}
