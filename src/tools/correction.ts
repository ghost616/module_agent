import { tool } from '@opencode-ai/plugin'
import type { ToolResult } from '@opencode-ai/plugin'
import { getAgentMode } from '../lib/session_state.ts'
import { resolveWorkspace, getWorkspaceDir } from '../lib/workspace.ts'
import { readCorrections, appendCorrection, removeCorrection } from '../lib/corrections.ts'

export const correctionTool = tool({
  description: '管理风后的用户纠正与反馈记录。add=记录一次用户纠正，read=读取所有历史纠正，remove=按索引删除指定记录。',
  args: {
    action: tool.schema.enum(['add', 'read', 'remove']).describe('操作类型：add 记录纠正，read 读取所有记录，remove 按索引删除'),
    content: tool.schema.string().optional().describe('action=add 时必填：用户纠正的具体内容'),
    index: tool.schema.number().optional().describe('action=remove 时必填：要删除的记录索引（从 read 返回结果中获取）'),
  },
  async execute(args, context): Promise<ToolResult> {
    const mode = getAgentMode(context.directory, context.sessionID)
    if (mode !== 'fengzhou') {
      return { title: '权限不足', output: JSON.stringify({ status: 'error', error: 'module_agent_correction 仅供风后调用。' }) }
    }

    const ws = await resolveWorkspace(context.directory, context.sessionID)
    if (!ws) {
      return { title: '无工作空间', output: JSON.stringify({ status: 'error', error: '未关联工作空间' }) }
    }
    const workspaceDir = getWorkspaceDir(context.directory, ws)

    if (args.action === 'add') {
      if (!args.content) {
        return { title: '参数错误', output: JSON.stringify({ status: 'error', error: 'action=add 时必须提供 content' }) }
      }
      await appendCorrection(workspaceDir, args.content)
      return { title: '已记录纠正', output: JSON.stringify({ status: 'ok', message: '用户纠正已记录' }) }
    }

    if (args.action === 'read') {
      const corrections = await readCorrections(workspaceDir)
      const entries = corrections.map((c, i) => ({ index: i, content: c.content, timestamp: c.timestamp }))
      return {
        title: `历史纠正记录（共 ${entries.length} 条）`,
        output: JSON.stringify({ status: 'ok', corrections: entries }),
      }
    }

    if (args.action === 'remove') {
      if (args.index === undefined) {
        return { title: '参数错误', output: JSON.stringify({ status: 'error', error: 'action=remove 时必须提供 index' }) }
      }
      const ok = await removeCorrection(workspaceDir, args.index)
      if (!ok) {
        return { title: '索引无效', output: JSON.stringify({ status: 'error', error: `索引 ${args.index} 不存在` }) }
      }
      return { title: '已删除纠正', output: JSON.stringify({ status: 'ok', message: `索引 ${args.index} 的记录已删除` }) }
    }

    return { title: '未知操作', output: JSON.stringify({ status: 'error', error: `未知 action: ${args.action}` }) }
  },
})
