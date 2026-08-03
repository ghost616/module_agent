import { tool } from '@opencode-ai/plugin'
import type { ToolResult } from '@opencode-ai/plugin'
import { testingArgsSchema } from '../lib/constants.ts'
import { getAgentMode } from '../lib/session_state.ts'
import { resolveWorkspace, getWorkspaceDir } from '../lib/workspace.ts'
import { getBoundStarter } from '../lib/module_session_tracker.ts'
import { runShellCommand, writeTestSpec, writeTestReport } from '../lib/testing.ts'

const MAX_BUFFER_CHECK = 10 * 1024 * 1024

export const testRunner = tool({
  description: `代码测试工具。支持三种操作：
- write_spec：风后或力牧写入待测试功能说明，供测试智能体读取
- write_report：离朱写入测试报告（Markdown 格式）
- check_playwright：检测 Playwright 是否安装（支持 npm 和 Python）

注意：unit（单元测试）、compile（编译检查）、e2e（端到端测试）已废弃，请直接使用 bash 工具执行对应命令。`,
  args: {
    action: tool.schema.enum(['write_spec', 'write_report', 'check_playwright']).describe('测试类型'),
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
          output: JSON.stringify({ status: 'error', error: 'module_agent_testing action="write_report" 仅供离朱调用。' }),
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
