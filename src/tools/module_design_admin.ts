import { join } from 'node:path'
import { tool } from '@opencode-ai/plugin'
import type { ToolResult } from '@opencode-ai/plugin'
import { getAgentMode } from '../lib/session_state.ts'
import { readModuleDesign, addOrUpdateModule } from '../lib/module_design.ts'
import { MODULE_AGENT_DIR, REQUIREMENTS_DESIGN_FILE, CODE_CONVENTIONS_FILE } from '../lib/constants.ts'
import { exists, readText, writeText } from '../lib/fs.ts'

async function checkPrerequisites(directory: string, mode: string): Promise<ToolResult | null> {
  if (mode === 'lishou') return null
  const requirementsPath = join(directory, MODULE_AGENT_DIR, REQUIREMENTS_DESIGN_FILE)
  if (!(await exists(requirementsPath))) {
    return {
      title: '需求设计文件不存在',
      output: JSON.stringify({
        status: 'error',
        error: '.module_agent/requirements_design.md 不存在。请先完成 Phase 1: 需求设计后重试。',
      }),
    }
  }
  const conventionsPath = join(directory, MODULE_AGENT_DIR, CODE_CONVENTIONS_FILE)
  if (!(await exists(conventionsPath))) {
    return {
      title: '代码规范文件不存在',
      output: JSON.stringify({
        status: 'error',
        error: '.module_agent/code_conventions.txt 不存在。请先完成 Phase 2: 代码规范后重试。',
      }),
    }
  }
  return null
}

export const moduleDesignAdmin = tool({
  description: '管理 module_design.json 中的模块设计条目。用于按模块增加和修改模块设计。',
  args: {
    action: tool.schema.enum(['add_module', 'update_module', 'read', 'read_code_conventions', 'update_code_conventions', 'read_requirements_design', 'update_requirements_design']).describe('操作类型'),
    module_name: tool.schema.string().optional().describe('模块名称'),
    description: tool.schema.string().optional().describe('模块描述（一句话）'),
    responsibilities: tool.schema.array(tool.schema.string()).optional().describe('职责列表'),
    dependencies: tool.schema.array(tool.schema.string()).optional().describe('依赖模块名列表'),
    functions: tool.schema.array(
      tool.schema.object({ name: tool.schema.string(), description: tool.schema.string() }),
    ).optional().describe('模块功能列表，包含功能名称和详细说明'),
    content: tool.schema.string().optional().describe('update_code_conventions / update_requirements_design：文件内容'),
  },
  async execute(args, context): Promise<ToolResult> {
    const mode = getAgentMode(context.directory, context.sessionID)
    if (mode !== 'fengzhou' && mode !== 'qibo' && mode !== 'lishou') {
      return {
        title: '权限不足',
        output: JSON.stringify({ status: 'error', error: 'module_design_admin 仅供风后、岐伯或隶首调用。请先使用 module_agent_start、module_agent_setup 或 module_agent_classifier 激活对应模式。' }),
      }
    }

    const directory = context.directory
    const action = args.action as string

    try {
      if (action === 'read') {
        const design = await readModuleDesign(directory)
        return {
          title: '模块设计',
          output: JSON.stringify(design, null, 2),
        }
      }

      if (action === 'read_code_conventions') {
        const path = join(directory, MODULE_AGENT_DIR, CODE_CONVENTIONS_FILE)
        if (!(await exists(path))) {
          return { title: '代码规范', output: '' }
        }
        return { title: '代码规范', output: await readText(path) }
      }

      if (action === 'update_code_conventions') {
        const content = args.content as string
        if (!content) {
          return { title: '参数错误', output: JSON.stringify({ status: 'error', error: 'content 必填' }) }
        }
        await writeText(join(directory, MODULE_AGENT_DIR, CODE_CONVENTIONS_FILE), content)
        return { title: '代码规范已更新', output: JSON.stringify({ status: 'ok', action: 'update_code_conventions' }) }
      }

      if (action === 'read_requirements_design') {
        const path = join(directory, MODULE_AGENT_DIR, REQUIREMENTS_DESIGN_FILE)
        if (!(await exists(path))) {
          return { title: '需求设计', output: '' }
        }
        return { title: '需求设计', output: await readText(path) }
      }

      if (action === 'update_requirements_design') {
        const content = args.content as string
        if (!content) {
          return { title: '参数错误', output: JSON.stringify({ status: 'error', error: 'content 必填' }) }
        }
        await writeText(join(directory, MODULE_AGENT_DIR, REQUIREMENTS_DESIGN_FILE), content)
        return { title: '需求设计已更新', output: JSON.stringify({ status: 'ok', action: 'update_requirements_design' }) }
      }

      const moduleName = args.module_name as string
      if (!moduleName) {
        return { title: '参数错误', output: JSON.stringify({ status: 'error', error: 'module_name 必填' }) }
      }

      if (action === 'add_module') {
        const result = await checkPrerequisites(directory, mode)
        if (result) return result
        await addOrUpdateModule(directory, {
          name: moduleName,
          description: args.description as string | undefined,
          responsibilities: args.responsibilities as string[] | undefined,
          dependencies: args.dependencies as string[] | undefined,
          functions: args.functions as { name: string; description: string }[] | undefined,
        }, false)
        return { title: `模块 '${moduleName}' 已添加到模块设计`, output: JSON.stringify({ status: 'ok', action: 'add_module', module_name: moduleName }) }
      }

      if (action === 'update_module') {
        const result = await checkPrerequisites(directory, mode)
        if (result) return result
        await addOrUpdateModule(directory, {
          name: moduleName,
          description: args.description as string | undefined,
          responsibilities: args.responsibilities as string[] | undefined,
          dependencies: args.dependencies as string[] | undefined,
          functions: args.functions as { name: string; description: string }[] | undefined,
        }, true)
        return { title: `模块 '${moduleName}' 设计已更新`, output: JSON.stringify({ status: 'ok', action: 'update_module', module_name: moduleName }) }
      }

      return { title: '未知操作', output: JSON.stringify({ status: 'error', error: `未知 action: ${action}` }) }
    } catch (err) {
      return { title: '执行错误', output: JSON.stringify({ status: 'error', error: (err as Error).message }) }
    }
  },
})
