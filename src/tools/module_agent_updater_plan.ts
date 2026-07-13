import { tool } from '@opencode-ai/plugin'
import type { ToolResult } from '@opencode-ai/plugin'
import { getAgentMode } from '../lib/session_state.ts'
import {
  updaterResultSchema,
  updaterAddPlanFilesSchema,
  updaterRemovePlanFilesSchema,
  updaterCheckActivePlanSchema,
} from '../lib/constants.ts'
import { findModule } from '../lib/module_tree.ts'
import { writeExecutionRecord } from '../lib/execution_result.ts'
import { addPlanFiles, removePlanFiles } from '../lib/plan_files.ts'
import { resolveWorkspace, getWorkspaceDir } from '../lib/workspace.ts'
import { getPlanIdBySession } from '../lib/session_plan_map.ts'
import { readPlan, readAllMetadata } from '../lib/development_plan.ts'
import { limuPlanGuard } from '../lib/limu_plan_guard.ts'

export const moduleAgentUpdaterPlan = tool({
  description: `
力牧执行进度管理工具。
支持操作：
- write_result：写入执行记录
- add_plan_files：写入计划修改的文件列表
- remove_plan_files：移除已修改完成的文件
- check_active_plan：检测计划有效性`,
  args: {
    action: tool.schema.enum(['write_result', 'add_plan_files', 'remove_plan_files', 'check_active_plan']).describe('操作类型'),
    module_name: tool.schema.string().optional().describe('模块唯一标识名称'),
    plan: tool.schema.string().optional().describe('write_result：开发计划摘要'),
    summary: tool.schema.string().optional().describe('write_result：执行总结'),
    modified_files: tool.schema.array(tool.schema.string()).optional().describe('write_result：修改文件列表'),
    errors: tool.schema.array(tool.schema.string()).optional().describe('write_result：错误信息列表'),
    files: tool.schema.array(tool.schema.string()).optional().describe('add_plan_files / remove_plan_files：文件路径列表'),
    status: tool.schema.enum(['started', 'running']).optional().describe('add_plan_files：执行状态'),
  },
  async execute(args, context): Promise<ToolResult> {
    const directory = context.directory
    const action = args.action as string
    const mode = getAgentMode(directory, context.sessionID)

    if (mode !== 'limu') {
      return {
        title: '权限不足',
        output: JSON.stringify({ status: 'error', error: 'module_agent_updater_plan 仅供力牧调用。' }),
      }
    }

    ;(args as any).session_id = context.sessionID

    const guard = await limuPlanGuard(directory, context.sessionID)
    if (guard) return guard

    let resolvedWorkspace: string | null = null
    if (action === 'write_result' || action === 'check_active_plan') {
      resolvedWorkspace = await resolveWorkspace(directory, context.sessionID)
      if (!resolvedWorkspace) {
        return {
          title: '未绑定工作空间',
          output: JSON.stringify({ status: 'error', error: '当前会话未关联工作空间' }),
        }
      }
    }
    const workspaceDir = resolvedWorkspace ? getWorkspaceDir(directory, resolvedWorkspace) : ''

    try {
      if (action === 'write_result') return handleWriteResult(directory, workspaceDir, args)
      if (action === 'add_plan_files') return handleAddPlanFiles(directory, args)
      if (action === 'remove_plan_files') return handleRemovePlanFiles(directory, args)
      if (action === 'check_active_plan') return handleCheckActivePlan(workspaceDir, context.sessionID)
      return { title: '未知操作', output: JSON.stringify({ status: 'error', error: `未知 action: ${action}` }) }
    } catch (err) {
      return { title: '执行错误', output: JSON.stringify({ status: 'error', error: (err as Error).message }) }
    }
  },
})

async function ensureModule(directory: string, moduleName: string): Promise<void> {
  const mod = await findModule(directory, moduleName)
  if (!mod) throw new Error(`模块 '${moduleName}' 不存在`)
}

async function handleWriteResult(directory: string, workspaceDir: string, args: any): Promise<ToolResult> {
  const validate = updaterResultSchema.safeParse(args)
  if (!validate.success) return { title: '参数错误', output: JSON.stringify({ status: 'error', error: validate.error.message }) }
  const { module_name, session_id, plan, modified_files, summary, errors } = validate.data
  const plan_id = await getPlanIdBySession(workspaceDir, session_id)
  if (!plan_id) {
    return { title: '未找到对应计划', output: JSON.stringify({ status: 'error', error: `会话 ${session_id} 未绑定计划` }) }
  }
  await ensureModule(directory, module_name)
  await writeExecutionRecord(workspaceDir, module_name, session_id, { plan_id, plan, modified_files, summary, errors })
  return { title: '已写入执行记录', output: JSON.stringify({ action: 'write_result', status: 'ok' }) }
}

async function handleAddPlanFiles(directory: string, args: any): Promise<ToolResult> {
  const validate = updaterAddPlanFilesSchema.safeParse(args)
  if (!validate.success) return { title: '参数错误', output: JSON.stringify({ status: 'error', error: validate.error.message }) }
  const { module_name, session_id, files, status } = validate.data
  await ensureModule(directory, module_name)
  await addPlanFiles(directory, module_name, session_id, files, status)
  return { title: `已写入 ${module_name} 文件修改计划`, output: JSON.stringify({ action: 'add_plan_files', status: 'ok', files_count: files.length }) }
}

async function handleRemovePlanFiles(directory: string, args: any): Promise<ToolResult> {
  const validate = updaterRemovePlanFilesSchema.safeParse(args)
  if (!validate.success) return { title: '参数错误', output: JSON.stringify({ status: 'error', error: validate.error.message }) }
  const { module_name, session_id, files } = validate.data
  await ensureModule(directory, module_name)
  await removePlanFiles(directory, module_name, session_id, files)
  return { title: `已移除 ${module_name} 文件修改计划`, output: JSON.stringify({ action: 'remove_plan_files', status: 'ok', removed: files.length }) }
}

async function handleCheckActivePlan(workspaceDir: string, sessionId: string): Promise<ToolResult> {
  const planId = await getPlanIdBySession(workspaceDir, sessionId)
  if (!planId) {
    return {
      title: '无活跃计划',
      output: JSON.stringify({ status: 'error', error: '当前会话未关联任何开发计划，无法执行文件修改。' }),
    }
  }

  const plan = await readPlan(workspaceDir, planId)
  if (!plan) {
    return {
      title: '计划不存在',
      output: JSON.stringify({ status: 'error', error: `计划 ${planId} 不存在。` }),
    }
  }

  const metadata = await readAllMetadata(workspaceDir)
  const meta = metadata.find(m => m.plan_id === planId)
  if (meta?.plan_completed) {
    return {
      title: '计划已完成',
      output: JSON.stringify({ status: 'error', error: `计划 ${planId} 已标记完成，无法继续修改文件。` }),
    }
  }

  return {
    title: '计划活跃',
    output: JSON.stringify({ status: 'ok', plan_id: planId, module_name: plan.module_name, plan_completed: false }),
  }
}
