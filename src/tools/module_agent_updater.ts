import { join } from 'node:path'
import { tool } from '@opencode-ai/plugin'
import type { ToolResult } from '@opencode-ai/plugin'
import { getAgentMode } from '../lib/session_state.ts'
import {
  updaterSpecSchema,
  updaterDefinitionSchema,
  updaterHistorySchema,
  updaterMoveSchema,
  updaterResultSchema,
  updaterAddPlanFilesSchema,
  updaterRemovePlanFilesSchema,
  moduleAgentDir,
  CHANGE_HISTORY_FILE,
} from '../lib/constants.ts'
import { findModule } from '../lib/module_tree.ts'
import { updateSpecSection } from '../lib/module_spec.ts'
import { modifyDefinition, readModuleDefinition, writeModuleDefinition } from '../lib/module_definition.ts'
import { writeExecutionRecord } from '../lib/execution_result.ts'
import { exists, readText, writeText } from '../lib/fs.ts'
import { addPlanFiles, removePlanFiles } from '../lib/plan_files.ts'
import { isReviewer, readReviewResult, writeReviewResult } from '../lib/review_result.ts'
import type { PlanReview, ReviewIssue } from '../lib/review_result.ts'
import { resolveWorkspace, getWorkspaceDir } from '../lib/workspace.ts'
import { getPlanIdBySession } from '../lib/session_plan_map.ts'
import { readPlan, readAllMetadata } from '../lib/development_plan.ts'
import { limuPlanGuard } from '../lib/limu_plan_guard.ts'

export const moduleAgentUpdater = tool({
  description: `
增量更新模块元数据文件，用于力牧在完成代码变更后记录结果。
支持操作：
- update_spec： 增/改 current_spec.md 中指定 heading 下的内容
- update_definition： 增/删/改 module_definition.json 中的文件条目
- move_definition： 将文件定义从一个模块移动到另一个模块，并在双方追加日志
- append_history： 向 change_history.log 追加变更记录
- write_result： 写入 execution_results/<session_id>.json
- add_plan_files： 力牧写入计划修改的文件列表
- remove_plan_files： 力牧移除已修改完的文件
- write_review： 皋陶写入审查结果`,
  args: {
    action: tool.schema.enum(['update_spec', 'update_definition', 'move_definition', 'append_history', 'write_result', 'add_plan_files', 'remove_plan_files', 'write_review', 'check_active_plan']).describe('操作类型'),
    module_name: tool.schema.string().optional().describe('模块唯一标识名称'),
    heading: tool.schema.string().optional().describe('update_spec：要修改的二级标题名（不含 ## 前缀）'),
    content: tool.schema.string().optional().describe('update_spec：该 section 的新增内容'),
    mode: tool.schema.enum(['set', 'add']).optional().describe('update_spec：set=替换；add=追加（默认 add）'),
    files_to_add: tool.schema.array(
      tool.schema.object({ path: tool.schema.string(), description: tool.schema.string() })
    ).optional().describe('update_definition：新增文件条目'),
    files_to_remove: tool.schema.array(tool.schema.string()).optional().describe('update_definition：按路径删除文件条目'),
    files_to_update: tool.schema.array(
      tool.schema.object({ path: tool.schema.string(), description: tool.schema.string() })
    ).optional().describe('update_definition：按路径更新 description'),
    target_module_name: tool.schema.string().optional().describe('move_definition：目标模块名称'),
    paths: tool.schema.array(tool.schema.string()).optional().describe('move_definition：要移动的文件路径列表'),
    session_id: tool.schema.string().optional().describe('append_history / move_definition / write_result / add_plan_files / remove_plan_files：会话 ID（力牧调用时自动从上下文获取，无需传入）'),
    entry: tool.schema.string().optional().describe('append_history：变更描述'),
    plan: tool.schema.string().optional().describe('write_result：开发计划摘要'),
    status: tool.schema.enum(['started', 'running', 'success', 'partial', 'failed']).optional().describe('write_result/add_plan_files：执行状态'),
    modified_files: tool.schema.array(tool.schema.string()).optional().describe('write_result：修改文件列表'),
    summary: tool.schema.string().optional().describe('write_result：执行总结'),
    errors: tool.schema.array(tool.schema.string()).optional().describe('write_result：错误信息列表'),
    files: tool.schema.array(tool.schema.string()).optional().describe('add_plan_files/remove_plan_files：文件路径列表'),
    review_summary: tool.schema.string().optional().describe('write_review：审查总结'),
    review_issues: tool.schema.array(
      tool.schema.object({ file: tool.schema.string(), line: tool.schema.number().optional(), severity: tool.schema.enum(['error', 'warning', 'info']), message: tool.schema.string() })
    ).optional().describe('write_review：问题列表'),
    review_approved: tool.schema.boolean().optional().describe('write_review：是否通过审查'),
    plan_id: tool.schema.string().optional().describe('write_review：计划 ID'),
  },
  async execute(args, context): Promise<ToolResult> {
    const directory = context.directory
    const action = args.action as string
    const mode = getAgentMode(directory, context.sessionID)

    const fengzhouAllowed = ['update_definition', 'move_definition']
    const lishouAllowed = ['update_spec']
    const gaotaoAllowed = ['write_review']
    const limuExcluded = ['write_review']

    if (mode === 'limu' && limuExcluded.includes(action)) {
      return {
        title: '权限不足',
        output: JSON.stringify({ status: 'error', error: `module_agent_updater action="${action}" 仅供皋陶调用。` }),
      }
    }
    if (mode !== 'limu' && !(mode === 'fengzhou' && fengzhouAllowed.includes(action)) && !(mode === 'lishou' && lishouAllowed.includes(action)) && !(mode === 'gaotao' && gaotaoAllowed.includes(action))) {
      return {
        title: '权限不足',
        output: JSON.stringify({ status: 'error', error: `module_agent_updater action="${action}" 权限不足。` }),
      }
    }

    if (mode === 'limu' || mode === 'gaotao') {
      args.session_id = context.sessionID
    }

    if (mode === 'limu') {
      const guard = await limuPlanGuard(directory, context.sessionID)
      if (guard) return guard
    }

    let resolvedWorkspace: string | null = null
    if (action === 'write_result' || action === 'write_review' || action === 'check_active_plan') {
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
      if (action === 'update_spec') return handleUpdateSpec(directory, args)
      if (action === 'update_definition') return handleUpdateDefinition(directory, args)
      if (action === 'move_definition') return handleMoveDefinition(directory, args)
      if (action === 'append_history') return handleAppendHistory(directory, args)
      if (action === 'write_result') return handleWriteResult(directory, workspaceDir, args)
      if (action === 'add_plan_files') return handleAddPlanFiles(directory, args)
      if (action === 'remove_plan_files') return handleRemovePlanFiles(directory, args)
      if (action === 'write_review') return handleWriteReview(workspaceDir, args, context.sessionID)
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

async function doAppendHistory(directory: string, moduleName: string, sessionId: string, message: string): Promise<void> {
  const timestamp = new Date().toISOString()
  const line = `[${timestamp}] [session: ${sessionId}] ${message}\n`
  const logPath = join(moduleAgentDir(directory, moduleName), CHANGE_HISTORY_FILE)
  let current = ''
  if (await exists(logPath)) current = await readText(logPath)
  await writeText(logPath, current + line)
}

async function handleUpdateSpec(directory: string, args: any): Promise<ToolResult> {
  const validate = updaterSpecSchema.safeParse(args)
  if (!validate.success) return { title: '参数错误', output: JSON.stringify({ status: 'error', error: validate.error.message }) }
  const { module_name, heading, content, mode } = validate.data
  await ensureModule(directory, module_name)
  await updateSpecSection(directory, module_name, heading, mode, content)
  return {
    title: `已更新 ${module_name} 功能说明`,
    output: JSON.stringify({ action: 'update_spec', status: 'ok', heading, path: `.module_agent/${module_name}/current_spec.md` }),
  }
}

async function handleUpdateDefinition(directory: string, args: any): Promise<ToolResult> {
  const validate = updaterDefinitionSchema.safeParse(args)
  if (!validate.success) return { title: '参数错误', output: JSON.stringify({ status: 'error', error: validate.error.message }) }
  const { module_name, files_to_add, files_to_remove, files_to_update } = validate.data
  await ensureModule(directory, module_name)
  await modifyDefinition(directory, module_name, { files_to_add, files_to_remove, files_to_update })
  const changes: string[] = []
  if (files_to_add?.length) changes.push(`新增 ${files_to_add.length} 个文件`)
  if (files_to_remove?.length) changes.push(`移除 ${files_to_remove.length} 个文件`)
  if (files_to_update?.length) changes.push(`更新 ${files_to_update.length} 个文件`)
  return { title: `已更新 ${module_name} 文件定义`, output: JSON.stringify({ action: 'update_definition', status: 'ok', changes }) }
}

async function handleMoveDefinition(directory: string, args: any): Promise<ToolResult> {
  const validate = updaterMoveSchema.safeParse(args)
  if (!validate.success) return { title: '参数错误', output: JSON.stringify({ status: 'error', error: validate.error.message }) }
  const { module_name, target_module_name, paths, session_id } = validate.data
  await ensureModule(directory, module_name)
  await ensureModule(directory, target_module_name)
  const srcDef = await readModuleDefinition(directory, module_name)
  const moveSet = new Set(paths)
  const movedFiles = srcDef.files.filter((f) => moveSet.has(f.path))
  const remaining = srcDef.files.filter((f) => !moveSet.has(f.path))
  await writeModuleDefinition(directory, module_name, { module_name, files: remaining })
  const targetDef = await readModuleDefinition(directory, target_module_name)
  const targetExisting = new Set(targetDef.files.map((f) => f.path))
  const newFiles = movedFiles.filter((f) => !targetExisting.has(f.path))
  await writeModuleDefinition(directory, target_module_name, { module_name: target_module_name, files: [...targetDef.files, ...newFiles] })
  const sid = session_id || ''
  const movedList = movedFiles.map((f) => f.path).join(', ')
  await doAppendHistory(directory, module_name, sid, `移出文件定义到 [${target_module_name}]: ${movedList}`)
  await doAppendHistory(directory, target_module_name, sid, `从 [${module_name}] 移入文件定义: ${movedList}`)
  return {
    title: `文件定义已从 ${module_name} 移动到 ${target_module_name}`,
    output: JSON.stringify({ action: 'move_definition', status: 'ok', moved: movedFiles.map((f) => f.path), from: module_name, to: target_module_name }),
  }
}

async function handleAppendHistory(directory: string, args: any): Promise<ToolResult> {
  const validate = updaterHistorySchema.safeParse(args)
  if (!validate.success) return { title: '参数错误', output: JSON.stringify({ status: 'error', error: validate.error.message }) }
  const { module_name, session_id, entry } = validate.data
  await ensureModule(directory, module_name)
  await doAppendHistory(directory, module_name, session_id, entry)
  return { title: `已追加 ${module_name} 变更记录`, output: JSON.stringify({ action: 'append_history', status: 'ok', entry }) }
}

async function handleWriteResult(directory: string, workspaceDir: string, args: any): Promise<ToolResult> {
  const validate = updaterResultSchema.safeParse(args)
  if (!validate.success) return { title: '参数错误', output: JSON.stringify({ status: 'error', error: validate.error.message }) }
  const { module_name, session_id, plan, status, modified_files, summary, errors } = validate.data
  await ensureModule(directory, module_name)
  await writeExecutionRecord(workspaceDir, module_name, session_id, { plan, status, modified_files, summary, errors })
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

async function handleWriteReview(workspaceDir: string, args: any, reviewerSessionId: string): Promise<ToolResult> {
  if (!isReviewer(reviewerSessionId)) {
    return { title: '审查信息缺失', output: JSON.stringify({ status: 'error', error: '当前会话不是审查会话。' }) }
  }

  const planId = args.plan_id as string
  if (!planId) {
    return { title: '参数错误', output: JSON.stringify({ status: 'error', error: 'write_review 需要 plan_id' }) }
  }

  const existing = await readReviewResult(workspaceDir, reviewerSessionId)
  const planReviews: PlanReview[] = existing?.planReviews ?? []

  const idx = planReviews.findIndex(p => p.plan_id === planId)
  const review: PlanReview = {
    plan_id: planId,
    summary: (args.review_summary as string) || '',
    issues: (args.review_issues as ReviewIssue[]) || [],
    approved: args.review_approved !== undefined ? (args.review_approved as boolean) : false,
  }

  if (idx >= 0) {
    planReviews[idx] = review
  } else {
    planReviews.push(review)
  }

  await writeReviewResult(workspaceDir, reviewerSessionId, {
    reviewer_session_id: reviewerSessionId,
    planReviews,
  })

  return {
    title: '已写入审查结果',
    output: JSON.stringify({ action: 'write_review', status: 'ok', plan_id: planId, approved: review.approved, issues_count: review.issues.length }),
  }
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
