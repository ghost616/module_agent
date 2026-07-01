import { tool } from '@opencode-ai/plugin'
import type { ToolResult } from '@opencode-ai/plugin'
import type { OpencodeClient } from '@opencode-ai/sdk'
import { getAgentMode } from '../lib/session_state.ts'
import { getBoundWorkspace, getWorkspaceDir } from '../lib/workspace.ts'
import { cleanWorkspaceStale, cleanExternalStale } from '../lib/stale_cleanup.ts'

export function createModuleAgentCleanup(client: OpencodeClient) {
  return tool({
    description: '清理失效数据（引用了已不存在会话的数据）。clean_workspace 清理当前绑定工作空间内的失效数据；clean_external 清理工作空间外（项目级）的失效数据。仅供风后调用。',
    args: {
      action: tool.schema.enum(['clean_workspace', 'clean_external']).describe('clean_workspace 清理空间内失效数据；clean_external 清理空间外失效数据'),
    },
    async execute(args, context): Promise<ToolResult> {
      if (getAgentMode(context.directory, context.sessionID) !== 'fengzhou') {
        return {
          title: '权限不足',
          output: JSON.stringify({ status: 'error', error: 'module_agent_cleanup 仅供风后调用。请先使用 module_agent_start 激活风后力牧模式。' }),
        }
      }

      const directory = context.directory
      const action = args.action as string

      if (action === 'clean_workspace') {
        const boundWs = await getBoundWorkspace(directory, context.sessionID)
        if (!boundWs) {
          return {
            title: '未绑定工作空间',
            output: JSON.stringify({ status: 'error', error: '请先通过 workspace(action="create"|"bind") 绑定工作空间' }),
          }
        }
        const workspaceDir = getWorkspaceDir(directory, boundWs)
        const removed = await cleanWorkspaceStale(client, workspaceDir)
        return {
          title: '空间内失效数据已清理',
          output: JSON.stringify({ status: 'ok', scope: 'workspace', removed }),
        }
      }

      const removed = await cleanExternalStale(client, directory)
      return {
        title: '空间外失效数据已清理',
        output: JSON.stringify({ status: 'ok', scope: 'external', removed }),
      }
    },
  })
}
