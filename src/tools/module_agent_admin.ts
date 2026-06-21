import { mkdir } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
import { join, relative, dirname } from 'node:path'
import { tool } from '@opencode-ai/plugin'
import type { ToolResult } from '@opencode-ai/plugin'
import { adminCreateSchema, adminUpdateSchema, adminListDirsSchema } from '../lib/constants.ts'
import { getAgentMode } from '../lib/session_state.ts'
import {
  moduleAgentDir,
  AGENT_PROFILE_FILE,
  CURRENT_SPEC_FILE,
  CHANGE_HISTORY_FILE,
  MODULE_DEFINITION_FILE,
  EXECUTION_RESULTS_DIR,
  defaultAgentProfile,
  defaultCurrentSpec,
  INITIAL_CHANGE_HISTORY,
} from '../lib/constants.ts'
import {
  addModule,
  findModule,
  readModuleTree,
  writeModuleTree,
} from '../lib/module_tree.ts'
import {
  writeAgentProfile,
} from '../lib/agent_profile.ts'
import {
  readModuleDefinition,
  writeModuleDefinition,
  removeFilesFromModule,
} from '../lib/module_definition.ts'
import { writeText } from '../lib/fs.ts'

export const moduleAgentAdmin = tool({
  description: '创建或修改力牧的配置与数据文件。用于管理项目中的模块结构。',
  args: {
    action: tool.schema.enum(['create', 'update', 'list_dirs', 'read_modules']).describe('操作类型：create 创建模块，update 修改模块，list_dirs 列出候选模块目录，read_modules 读取所有模块'),
    module_name: tool.schema.string().optional().describe('模块唯一标识名称（list_dirs 时无需提供）'),
    description: tool.schema.string().optional().describe('模块说明（create/update 时有效）'),
    agent_profile_content: tool.schema.string().optional().describe('智能体文本内容，定义角色、专长、代码规范'),
    initial_spec: tool.schema.string().optional().describe('初始功能说明（仅 create 时有效）'),
    ignore: tool.schema.array(tool.schema.string()).optional().describe('list_dirs：忽略目录名列表'),
  },
  async execute(args, context): Promise<ToolResult> {
    if (getAgentMode(context.directory, context.sessionID) !== 'fengzhou') {
      return {
        title: '权限不足',
        output: JSON.stringify({ status: 'error', error: 'module_agent_admin 仅供风后调用。' }),
      }
    }

    const directory = context.directory
    const action = args.action as string

    if (action === 'read_modules') {
      const tree = await readModuleTree(directory)
      return {
        title: `模块列表 (${tree.modules.length})`,
        output: JSON.stringify({ status: 'ok', modules: tree.modules }),
      }
    }

    if (action === 'list_dirs') {
      const validate = adminListDirsSchema.passthrough().safeParse(args)
      if (!validate.success) {
        return { title: '参数错误', output: JSON.stringify({ status: 'error', error: validate.error.message }) }
      }
      return handleListDirs(directory, validate.data.ignore)
    }

    if (action === 'create') {
      const validate = adminCreateSchema.passthrough().safeParse(args)
      if (!validate.success) {
        return { title: '参数错误', output: JSON.stringify({ status: 'error', error: validate.error.message }) }
      }
      return handleCreate(directory, validate.data)
    }

    const validate = adminUpdateSchema.passthrough().safeParse(args)
    if (!validate.success) {
      return { title: '参数错误', output: JSON.stringify({ status: 'error', error: validate.error.message }) }
    }
    return handleUpdate(directory, validate.data)
  },
})

async function handleCreate(
  directory: string,
  args: { module_name: string; description?: string; agent_profile_content?: string; initial_spec?: string },
): Promise<ToolResult> {
  const { module_name, description, agent_profile_content, initial_spec } = args

  const existingModule = await findModule(directory, module_name)
  if (existingModule) {
    return {
      title: '模块已存在',
      output: JSON.stringify({ status: 'error', error: `模块 '${module_name}' 已存在` }),
    }
  }

  // 创建 .module_agent/<module_name>/ 目录结构
  const agentDir = moduleAgentDir(directory, module_name)
  const resultsDir = join(agentDir, EXECUTION_RESULTS_DIR)
  await mkdir(agentDir, { recursive: true })
  await mkdir(resultsDir, { recursive: true })

  const profileContent = agent_profile_content || defaultAgentProfile(module_name)
  const specContent = initial_spec || defaultCurrentSpec(module_name)

  await writeText(join(agentDir, AGENT_PROFILE_FILE), profileContent)
  await writeText(join(agentDir, CURRENT_SPEC_FILE), specContent)
  await writeText(join(agentDir, CHANGE_HISTORY_FILE), INITIAL_CHANGE_HISTORY)

  await addModule(directory, { name: module_name, description: description || '' })

  const paths = [
    join('.module_agent', module_name, AGENT_PROFILE_FILE),
    join('.module_agent', module_name, CURRENT_SPEC_FILE),
    join('.module_agent', module_name, CHANGE_HISTORY_FILE),
    join('.module_agent', module_name, EXECUTION_RESULTS_DIR) + '/',
  ]

  return {
    title: `模块 '${module_name}' 创建成功`,
    output: JSON.stringify({ status: 'created', paths }),
  }
}

async function handleUpdate(
  directory: string,
  args: { module_name: string; description?: string; agent_profile_content?: string },
): Promise<ToolResult> {
  const { module_name, description, agent_profile_content } = args

  const existingModule = await findModule(directory, module_name)
  if (!existingModule) {
    return {
      title: '模块不存在',
      output: JSON.stringify({ status: 'error', error: `模块 '${module_name}' 不存在，请先创建` }),
    }
  }

  const changedFiles: string[] = []

  if (description !== undefined) {
    const tree = await readModuleTree(directory)
    const modEntry = tree.modules.find((m) => m.name === module_name)
    if (modEntry) modEntry.description = description
    await writeModuleTree(directory, tree)
    changedFiles.push('.module_agent/module_tree.json')
  }

  if (agent_profile_content !== undefined) {
    await writeAgentProfile(directory, module_name, agent_profile_content)
    changedFiles.push(join('.module_agent', module_name, AGENT_PROFILE_FILE))
  }

  return {
    title: `模块 '${module_name}' 更新成功`,
    output: JSON.stringify({ status: 'updated', changed_files: changedFiles }),
  }
}

async function handleListDirs(directory: string, ignore: string[]): Promise<ToolResult> {
  const ignoreSet = new Set(ignore)
  // 收集所有已分配的文件路径
  const tree = await readModuleTree(directory)
  const assignedFiles = new Set<string>()
  for (const m of tree.modules) {
    try {
      const def = await readModuleDefinition(directory, m.name)
      for (const f of def.files) {
        assignedFiles.add(f.path)
      }
    } catch {
      // module_definition 不存在 → 跳过
    }
  }

  const candidateDirs = new Set<string>()

  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (ignoreSet.has(entry.name)) continue
      if (entry.name.startsWith('.')) continue

      const fullPath = join(dir, entry.name)
      await walk(fullPath)
    }
    // 检查当前目录下是否有未分配的文件
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const relPath = relative(directory, join(dir, entry.name)).replace(/\\/g, '/')
      if (!assignedFiles.has(relPath)) {
        candidateDirs.add(relative(directory, dir).replace(/\\/g, '/'))
        break
      }
    }
  }

  await walk(directory)

  // root level files → path = "."
  const rootEntries = await readdir(directory, { withFileTypes: true })
  if (rootEntries.some((e) => e.isFile())) {
    const relPath = relative(directory, directory).replace(/\\/g, '/') || '.'
    candidateDirs.add(relPath)
  }

  return {
    title: `未分配文件的目录 (${candidateDirs.size})`,
    output: JSON.stringify({ status: 'ok', candidates: [...candidateDirs] }),
  }
}
