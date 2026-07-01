import { tool } from '@opencode-ai/plugin'
import type { ToolResult } from '@opencode-ai/plugin'
import { getAgentMode } from '../lib/session_state.ts'
import { findModule } from '../lib/module_tree.ts'
import { backupFile, readLatestBackup } from '../lib/file_backup.ts'
import { limuPlanGuard } from '../lib/limu_plan_guard.ts'

export const moduleAgentBackup = tool({
  description: '力牧修改文件前对文件进行备份，风后可读取最新的备份文件。',
  args: {
    action: tool.schema.enum(['backup', 'read_latest']).describe('操作类型：backup 备份文件（力牧调用），read_latest 读取最新备份（风后或力牧调用）'),
    module_name: tool.schema.string().describe('模块唯一标识名称'),
    file_path: tool.schema.string().describe('相对文件路径（如 src/auth/login.ts）'),
  },
  async execute(args, context): Promise<ToolResult> {
    const directory = context.directory
    const action = args.action as string
    const moduleName = args.module_name as string
    const filePath = args.file_path as string

    const mod = await findModule(directory, moduleName)
    if (!mod) {
      return {
        title: '模块不存在',
        output: JSON.stringify({ status: 'error', error: `模块 '${moduleName}' 不存在` }),
      }
    }

    if (action === 'backup') {
      if (getAgentMode(directory, context.sessionID) !== 'limu') {
        return {
          title: '权限不足',
          output: JSON.stringify({ status: 'error', error: 'backup 操作仅供力牧调用。' }),
        }
      }

      const guard = await limuPlanGuard(directory, context.sessionID)
      if (guard) return guard

      const result = await backupFile(directory, moduleName, filePath)
      return {
        title: result.success ? '备份成功' : '备份失败',
        output: JSON.stringify({ status: result.success ? 'ok' : 'error', message: result.message }),
      }
    }

    if (action === 'read_latest') {
      const mode = getAgentMode(directory, context.sessionID)
      if (mode !== 'fengzhou' && mode !== 'limu' && mode !== 'gaotao') {
        return {
          title: '权限不足',
          output: JSON.stringify({ status: 'error', error: 'read_latest 操作仅供风后、力牧或皋陶调用。' }),
        }
      }

      const result = await readLatestBackup(directory, moduleName, filePath)
      if (!result.success) {
        return {
          title: '读取失败',
          output: JSON.stringify({ status: 'error', message: result.message }),
        }
      }

      return {
        title: '读取备份成功',
        output: JSON.stringify({ status: 'ok', message: result.message, content: result.content }),
      }
    }

    return {
      title: '未知操作',
      output: JSON.stringify({ status: 'error', error: `未知 action: ${action}` }),
    }
  },
})
