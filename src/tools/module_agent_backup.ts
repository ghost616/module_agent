import { tool } from '@opencode-ai/plugin'
import type { ToolResult } from '@opencode-ai/plugin'
import { getAgentMode } from '../lib/session_state.ts'
import { findModule } from '../lib/module_tree.ts'
import { backupFile, listBackups, readBackupContent } from '../lib/file_backup.ts'
import { limuPlanGuard } from '../lib/limu_plan_guard.ts'

export const moduleAgentBackup = tool({
  description: '力牧修改文件前对文件进行备份，风后可读取备份文件列表及内容。',
  args: {
    action: tool.schema.enum(['backup', 'list', 'read_backup_content']).describe('操作类型：backup 备份文件（力牧调用），list 获取备份文件名列表（风后/力牧/皋陶调用），read_backup_content 按备份文件名和行范围读取内容（风后/力牧/皋陶调用）'),
    module_name: tool.schema.string().describe('模块唯一标识名称'),
    file_path: tool.schema.string().describe('相对文件路径（如 src/auth/login.ts）'),
    backup_file_name: tool.schema.string().optional().describe('read_backup_content：备份文件名（从 list 返回的 files 列表中获取，仅为文件名如 1734567890123.bak）'),
    start_line: tool.schema.number().optional().describe('read_backup_content：起始行号（0-based，默认 0）'),
    end_line: tool.schema.number().optional().describe('read_backup_content：结束行号（0-based，默认到末尾）'),
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

    if (action === 'list' || action === 'read_backup_content') {
      const mode = getAgentMode(directory, context.sessionID)
      if (mode !== 'fengzhou' && mode !== 'limu' && mode !== 'gaotao') {
        return {
          title: '权限不足',
          output: JSON.stringify({ status: 'error', error: `${action} 操作仅供风后、力牧或皋陶调用。` }),
        }
      }

      if (action === 'list') {
        const result = await listBackups(directory, moduleName, filePath)
        return {
          title: result.success ? `备份文件列表 (${(result.files || []).length})` : '读取失败',
          output: JSON.stringify({ status: result.success ? 'ok' : 'error', message: result.message, files: result.files || [] }),
        }
      }

      if (action === 'read_backup_content') {
        const backupFileName = (args as any).backup_file_name as string
        if (!backupFileName) {
          return { title: '参数错误', output: JSON.stringify({ status: 'error', error: 'read_backup_content 需提供 backup_file_name' }) }
        }
        const startLine = ((args as any).start_line as number) ?? 0
        const endLine = (args as any).end_line as number | undefined
        const result = await readBackupContent(directory, moduleName, filePath, backupFileName, startLine, endLine)
        if (!result.success) {
          return { title: '读取失败', output: JSON.stringify({ status: 'error', message: result.message }) }
        }
        return {
          title: `备份内容: ${backupFileName}`,
          output: JSON.stringify({ status: 'ok', message: result.message, backup_file_name: backupFileName, content: result.content }, null, 2),
        }
      }
    }

    return {
      title: '未知操作',
      output: JSON.stringify({ status: 'error', error: `未知 action: ${action}` }),
    }
  },
})
