import { tool } from '@opencode-ai/plugin'
import type { ToolResult } from '@opencode-ai/plugin'
import { testingArgsSchema } from '../lib/constants.ts'
import { getAgentMode } from '../lib/session_state.ts'
import { resolveWorkspace, getWorkspaceDir } from '../lib/workspace.ts'
import { getBoundStarter } from '../lib/module_session_tracker.ts'
import { runShellCommand, runHttpRequest, runAssertions, writeTestResult, writeTestSpec, writeTestReport } from '../lib/testing.ts'

const MAX_BUFFER_CHECK = 10 * 1024 * 1024

function printAssertions(res: { passed: number; failed: number; failures: any[] }): string {
  const parts: string[] = [`passed: ${res.passed}`, `failed: ${res.failed}`]
  for (const f of res.failures) {
    parts.push(`  [${f.type}] expected: ${JSON.stringify(f.expected)}, actual: ${JSON.stringify(f.actual)}${f.key ? ` (key: ${f.key})` : ''}`)
  }
  return parts.join('\n')
}

export const testRunner = tool({
  description: `代码测试工具。支持四种操作：
- interface：发送 HTTP API 请求并自动断言
- write_spec：风后或力牧写入待测试功能说明，供测试智能体读取
- write_report：离朱写入测试报告（Markdown 格式）
- check_playwright：检测 Playwright 是否安装（支持 npm 和 Python）

注意：unit（单元测试）、compile（编译检查）、e2e（端到端测试）已废弃，请直接使用 bash 工具执行对应命令。`,
  args: {
    action: tool.schema.enum(['interface', 'write_spec', 'write_report', 'check_playwright']).describe('测试类型'),
    method: tool.schema.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']).optional().describe('interface：HTTP 方法'),
    url: tool.schema.string().optional().describe('interface：请求 URL'),
    headers: tool.schema.record(tool.schema.string(), tool.schema.string()).optional().describe('interface：请求头'),
    body: tool.schema.union([tool.schema.string(), tool.schema.record(tool.schema.string(), tool.schema.any())]).optional().describe('interface：请求体（对象自动 JSON 序列化）'),
    timeout: tool.schema.number().optional().describe('超时 ms（interface: 30s）'),
    expected_status: tool.schema.number().optional().describe('interface：期望 HTTP 状态码'),
    expected_body_contains: tool.schema.string().optional().describe('interface：期望响应体包含的字符串'),
    expected_headers: tool.schema.record(tool.schema.string(), tool.schema.string()).optional().describe('interface：期望响应头'),
    content: tool.schema.string().optional().describe('write_spec/write_report：Markdown 内容'),
  },
  async execute(args, context): Promise<ToolResult> {
    const validate = testingArgsSchema.safeParse(args)
    if (!validate.success) {
      return { title: '参数错误', output: JSON.stringify({ status: 'error', error: validate.error.message }) }
    }
    const validated = validate.data
    const directory = context.directory
    const sessionId = context.sessionID

    const mode = getAgentMode(directory, sessionId)
    const action = validated.action

    if (action === 'write_spec') {
      if (mode !== 'fengzhou' && mode !== 'limu') {
        return {
          title: '权限不足',
          output: JSON.stringify({ status: 'error', error: 'module_agent_testing action="write_spec" 仅供风后或力牧调用。' }),
        }
      }
    } else if (action === 'check_playwright') {
      if (mode !== 'fengzhou' && mode !== 'limu' && mode !== 'lizhu') {
        return {
          title: '权限不足',
          output: JSON.stringify({ status: 'error', error: 'module_agent_testing action="check_playwright" 仅供风后、力牧或离朱调用。' }),
        }
      }
    } else {
      if (mode !== 'lizhu') {
        return {
          title: '权限不足',
          output: JSON.stringify({ status: 'error', error: 'module_agent_testing action="interface"|"write_report" 仅供离朱调用。' }),
        }
      }
    }

    let workspaceDir = ''
    try {
      const ws = await resolveWorkspace(directory, sessionId)
      if (ws) workspaceDir = getWorkspaceDir(directory, ws)
    } catch {
      // no workspace — execute anyway, skip storage
    }

    if (action !== 'check_playwright' && mode === 'lizhu') {
      if (!workspaceDir) {
        return { title: '未绑定启动者', output: JSON.stringify({ status: 'error', error: '离朱未绑定启动者，无法执行测试操作。' }) }
      }
      const starter = await getBoundStarter(workspaceDir, sessionId)
      if (!starter) {
        return { title: '未绑定启动者', output: JSON.stringify({ status: 'error', error: '离朱未绑定启动者，无法执行测试操作。' }) }
      }
    }

    if (action === 'interface') {
      const { method, url, headers, body, timeout, expected_status, expected_body_contains, expected_headers } = validated
      const httpResult = await runHttpRequest(method, url, headers ?? {}, body, timeout ?? 30000)

      const assertions = expected_status !== undefined || expected_body_contains !== undefined || (expected_headers && Object.keys(expected_headers).length > 0)
        ? runAssertions(httpResult, expected_status, expected_body_contains, expected_headers)
        : undefined

      const requestBodyStr = body !== undefined ? (typeof body === 'object' ? JSON.stringify(body) : String(body)) : undefined

      const result = {
        session_id: sessionId,
        action: 'interface' as const,
        request: {
          method,
          url,
          headers: headers ?? {},
          body: requestBodyStr,
        },
        response: {
          status_code: httpResult.status_code,
          headers: httpResult.headers,
          body: httpResult.body,
        },
        duration_ms: httpResult.duration_ms,
        assertions,
        timestamp: new Date().toISOString(),
      }

      if (workspaceDir) await writeTestResult(workspaceDir, 'interface', sessionId, result).catch(() => {})

      if (assertions && assertions.failed > 0) {
        return {
          title: `接口测试失败: ${method} ${url} → ${httpResult.status_code} (${httpResult.duration_ms}ms)`,
          output: JSON.stringify({ status: 'fail', status_code: httpResult.status_code, response_body: httpResult.body, assertions: printAssertions(assertions), duration_ms: httpResult.duration_ms }),
        }
      }

      if (assertions && assertions.passed > 0) {
        return {
          title: `接口测试通过: ${method} ${url} → ${httpResult.status_code} (${httpResult.duration_ms}ms)`,
          output: JSON.stringify({ status: 'pass', status_code: httpResult.status_code, assertions: printAssertions(assertions), duration_ms: httpResult.duration_ms }),
        }
      }

      return {
        title: `${method} ${url} → ${httpResult.status_code} (${httpResult.duration_ms}ms)`,
        output: JSON.stringify({ status: 'ok', status_code: httpResult.status_code, response_body: httpResult.body, duration_ms: httpResult.duration_ms }),
      }
    }

    if (action === 'write_spec') {
      const { content } = validated
      if (!workspaceDir) {
        return { title: '存储失败', output: JSON.stringify({ status: 'error', error: '未关联工作空间，无法存储测试说明。' }) }
      }
      await writeTestSpec(workspaceDir, sessionId, content)
      return {
        title: '已写入测试说明',
        output: JSON.stringify({ action: 'write_spec', status: 'ok', path: `test_specs/${sessionId}.json` }),
      }
    }

    if (action === 'write_report') {
      const { content } = validated
      if (!workspaceDir) {
        return { title: '存储失败', output: JSON.stringify({ status: 'error', error: '未关联工作空间，无法存储测试报告。' }) }
      }
      await writeTestReport(workspaceDir, sessionId, content)
      return {
        title: '已写入测试报告',
        output: JSON.stringify({ action: 'write_report', status: 'ok', path: `test_reports/${sessionId}.json` }),
      }
    }

    if (action === 'check_playwright') {
      const npmResult = await runShellCommand('npx playwright --version', directory, 30000, MAX_BUFFER_CHECK)
      if (npmResult.exit_code === 0) {
        return {
          title: 'Playwright 已安装 (npm)',
          output: JSON.stringify({ installed: true, source: 'npm', version: npmResult.stdout.trim() }),
        }
      }

      const pyResult = await runShellCommand('python -c "import playwright; print(getattr(playwright, \'__version__\', \'\'))"', directory, 30000, MAX_BUFFER_CHECK)
      if (pyResult.exit_code === 0) {
        return {
          title: 'Playwright 已安装 (Python)',
          output: JSON.stringify({ installed: true, source: 'python', version: pyResult.stdout.trim() || 'unknown' }),
        }
      }

      return {
        title: 'Playwright 未安装',
        output: JSON.stringify({ installed: false }),
      }
    }

    return { title: '未知操作', output: JSON.stringify({ status: 'error', error: `未知 action: ${action}` }) }
  },
})
