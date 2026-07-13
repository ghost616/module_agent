import { join } from 'node:path'
import { tool } from '@opencode-ai/plugin'
import type { ToolResult } from '@opencode-ai/plugin'
import { getAgentMode } from '../lib/session_state.ts'
import {
  updaterSpecSchema,
  updaterDefinitionSchema,
  updaterHistorySchema,
  updaterMoveSchema,
  moduleAgentDir,
  CHANGE_HISTORY_FILE,
} from '../lib/constants.ts'
import { findModule } from '../lib/module_tree.ts'
import { updateSpecSection } from '../lib/module_spec.ts'
import { modifyDefinition, readModuleDefinition, writeModuleDefinition } from '../lib/module_definition.ts'
import { exists, readText, writeText } from '../lib/fs.ts'
import { limuPlanGuard } from '../lib/limu_plan_guard.ts'

export const moduleAgentUpdater = tool({
  description: `
增量更新模块元数据文件。
支持操作：
- update_spec： 增/改 current_spec.md 中指定 heading 下的内容
- update_definition： 增/删/改 module_definition.json 中的文件条目
- move_definition： 将文件定义从一个模块移动到另一个模块，并在双方追加日志
- append_history： 向 change_history.log 追加变更记录`,
  args: {
    action: tool.schema.enum(['update_spec', 'update_definition', 'move_definition', 'append_history']).describe('操作类型'),
    module_name: tool.schema.string().optional().describe('模块唯一标识名称'),
    heading: tool.schema.string().optional().describe('update_spec：要修改的二级标题名（不含 ## 前缀）'),
    content: tool.schema.string().optional().describe('update_spec：该 section 的新增内容'),
    mode: tool.schema.enum(['set', 'add']).optional().describe('update_spec：set=替换；add=追加（默认 add）'),
    files_to_add: tool.schema.array(
      tool.schema.object({ path: tool.schema.string(), description: tool.schema.string() })
    ).optional().describe('update_definition：新增文件条目（description 为该文件整体功能职责的完整说明）'),
    files_to_remove: tool.schema.array(tool.schema.string()).optional().describe('update_definition：按路径删除文件条目'),
    files_to_update: tool.schema.array(
      tool.schema.object({ path: tool.schema.string(), description: tool.schema.string() })
    ).optional().describe('update_definition：按路径更新 description（会整体替换旧 description，须提供包含文件已有职责的完整累积说明，避免覆盖历史说明；本次计划变更请记入 append_history）'),
    target_module_name: tool.schema.string().optional().describe('move_definition：目标模块名称'),
    paths: tool.schema.array(tool.schema.string()).optional().describe('move_definition：要移动的文件路径列表'),
    entry: tool.schema.string().optional().describe('append_history：变更描述'),
  },
  async execute(args, context): Promise<ToolResult> {
    const directory = context.directory
    const action = args.action as string
    const mode = getAgentMode(directory, context.sessionID)

    const fengzhouAllowed = ['update_definition', 'move_definition']
    const lishouAllowed = ['update_spec']

    if (mode === 'fengzhou' && !fengzhouAllowed.includes(action)) {
      return {
        title: '权限不足',
        output: JSON.stringify({ status: 'error', error: `风后仅可使用 module_agent_updater 的 update_definition 和 move_definition 操作。` }),
      }
    }
    if (mode === 'lishou' && !lishouAllowed.includes(action)) {
      return {
        title: '权限不足',
        output: JSON.stringify({ status: 'error', error: '隶首仅可使用 module_agent_updater 的 update_spec 操作。' }),
      }
    }
    if (mode !== 'limu' && mode !== 'fengzhou' && mode !== 'lishou') {
      return {
        title: '权限不足',
        output: JSON.stringify({ status: 'error', error: `module_agent_updater action="${action}" 权限不足。` }),
      }
    }

    if (mode === 'limu' || mode === 'fengzhou') {
      ;(args as any).session_id = context.sessionID
    }
    if (mode === 'limu') {
      const guard = await limuPlanGuard(directory, context.sessionID)
      if (guard) return guard
    }

    try {
      if (action === 'update_spec') return handleUpdateSpec(directory, args)
      if (action === 'update_definition') return handleUpdateDefinition(directory, args)
      if (action === 'move_definition') return handleMoveDefinition(directory, args)
      if (action === 'append_history') return handleAppendHistory(directory, args)
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
