import { join } from 'node:path'
import { tool } from '@opencode-ai/plugin'
import type { ToolResult } from '@opencode-ai/plugin'
import { findModule } from '../lib/module_tree.ts'
import { getAgentMode } from '../lib/session_state.ts'
import { limuPlanGuard } from '../lib/limu_plan_guard.ts'
import { readCurrentSpec } from '../lib/module_spec.ts'
import { readModuleDefinition, getModuleParentDirs } from '../lib/module_definition.ts'
import { moduleAgentDir, CHANGE_HISTORY_FILE } from '../lib/constants.ts'
import { exists, readText } from '../lib/fs.ts'
import { readPlanFiles } from '../lib/plan_files.ts'

export const moduleAgentReader = tool({
  description: '读取模块元数据文件，供风后在评估变更、力牧在执行时使用。',
  args: {
    action: tool.schema.enum(['read_spec', 'read_definition', 'read_history', 'read_dirs', 'read_plan_files']).describe('读取目标文件'),
    module_name: tool.schema.string().describe('模块唯一标识名称'),
    from: tool.schema.string().optional().describe('read_history：起始时间 ISO 8601（含）'),
    to: tool.schema.string().optional().describe('read_history：结束时间 ISO 8601（含）'),
  },
  async execute(args, context): Promise<ToolResult> {
    const mode = getAgentMode(context.directory, context.sessionID)
    if (mode !== 'fengzhou' && mode !== 'limu' && mode !== 'gaotao' && mode !== 'lishou') {
      return {
        title: '权限不足',
        output: JSON.stringify({ status: 'error', error: 'module_agent_reader 仅供风后、力牧、皋陶或隶首调用。' }),
      }
    }

    if (mode === 'limu') {
      const guard = await limuPlanGuard(context.directory, context.sessionID)
      if (guard) return guard
    }

    const directory = context.directory
    const action = args.action as string
    const moduleName = args.module_name as string

    const mod = await findModule(directory, moduleName)
    if (!mod) {
      return {
        title: '模块不存在',
        output: JSON.stringify({ status: 'error', error: `模块 '${moduleName}' 不存在` }),
      }
    }

    try {
      if (action === 'read_spec') {
        const content = await readCurrentSpec(directory, moduleName)
        return { title: `${moduleName} 功能说明`, output: content || '(空)' }
      }

      if (action === 'read_definition') {
        const def = await readModuleDefinition(directory, moduleName)
        return { title: `${moduleName} 文件定义`, output: JSON.stringify(def, null, 2) }
      }

      if (action === 'read_dirs') {
        const dirs = await getModuleParentDirs(directory, moduleName)
        return { title: `${moduleName} 文件所在目录`, output: JSON.stringify(dirs) }
      }

      if (action === 'read_plan_files') {
        const data = await readPlanFiles(directory, moduleName)
        if (!data) return { title: `${moduleName} 无文件修改计划`, output: JSON.stringify({ files: [] }) }
        return { title: `${moduleName} 文件修改计划`, output: JSON.stringify(data) }
      }

      if (action === 'read_history') {
        const logPath = join(moduleAgentDir(directory, moduleName), CHANGE_HISTORY_FILE)
        const content = (await exists(logPath)) ? await readText(logPath) : ''
        const from = (args as any).from as string | undefined
        const to = (args as any).to as string | undefined
        if (!from && !to) {
          return { title: `${moduleName} 变更历史`, output: content || '(空)' }
        }
        const fromMs = from ? Date.parse(from) : 0
        const toMs = to ? Date.parse(to) : Infinity
        if (isNaN(fromMs) || isNaN(toMs)) {
          return { title: '参数错误', output: JSON.stringify({ status: 'error', error: 'from/to 需为有效 ISO 8601 时间字符串' }) }
        }
        const re = /^\[(.+?)\]/
        const filtered = content
          .split('\n')
          .filter((line) => {
            const m = line.match(re)
            if (!m) return false
            const ts = Date.parse(m[1])
            return !isNaN(ts) && ts >= fromMs && ts <= toMs
          })
          .join('\n')
        return { title: `${moduleName} 变更历史`, output: filtered || '(空)' }
      }

      return { title: '未知操作', output: JSON.stringify({ status: 'error', error: `未知 action: ${action}` }) }
    } catch (err) {
      return { title: '读取失败', output: JSON.stringify({ status: 'error', error: (err as Error).message }) }
    }
  },
})
