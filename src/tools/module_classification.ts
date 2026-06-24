import { mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tool } from '@opencode-ai/plugin'
import type { ToolResult } from '@opencode-ai/plugin'
import { getAgentMode } from '../lib/session_state.ts'
import { addModule, findModule } from '../lib/module_tree.ts'
import { readModuleDefinition, writeModuleDefinition } from '../lib/module_definition.ts'
import { addOrUpdateModule } from '../lib/module_design.ts'
import { exists, readJson, writeText } from '../lib/fs.ts'
import {
  moduleAgentDir,
  AGENT_PROFILE_FILE,
  CURRENT_SPEC_FILE,
  CHANGE_HISTORY_FILE,
  EXECUTION_RESULTS_DIR,
  INITIAL_CHANGE_HISTORY,
  defaultCurrentSpec,
} from '../lib/constants.ts'

interface ClassificationFile {
  path: string
  description: string
}

interface ClassificationEntry {
  name: string
  files: ClassificationFile[]
  bound_module: string | null
  is_new_module: boolean
}

interface ClassificationData {
  session_id: string
  directory: string
  classifications: ClassificationEntry[]
}

function getFilePath(directory: string, sessionId: string): string {
  return join(directory, '.module_agent', 'classifications', `${sessionId}.json`)
}

async function readData(directory: string, sessionId: string): Promise<ClassificationData> {
  const path = getFilePath(directory, sessionId)
  if (!(await exists(path))) {
    return { session_id: sessionId, directory: '', classifications: [] }
  }
  try {
    return await readJson<ClassificationData>(path)
  } catch {
    return { session_id: sessionId, directory: '', classifications: [] }
  }
}

async function writeData(directory: string, sessionId: string, data: ClassificationData): Promise<void> {
  const path = getFilePath(directory, sessionId)
  await mkdir(dirname(path), { recursive: true })
  await writeText(path, JSON.stringify(data, null, 2))
}

export const moduleClassification = tool({
  description: '管理分类结果：添加/修改/删除分类、绑定模块、将分类写入 module_definition。仅供隶首调用。',
  args: {
    action: tool.schema.enum(['add', 'update', 'delete', 'bind_module', 'apply']).describe('操作类型'),
    directory_path: tool.schema.string().optional().describe('add：当前扫描的目录路径'),
    classifications: tool.schema.array(
      tool.schema.object({
        name: tool.schema.string(),
        files: tool.schema.array(
          tool.schema.object({ path: tool.schema.string(), description: tool.schema.string() })
        ),
      })
    ).optional().describe('add：要添加的分类条目'),
    classification_name: tool.schema.string().optional().describe('update/delete/bind_module/apply：分类名称'),
    name: tool.schema.string().optional().describe('update：新分类名称'),
    files_to_add: tool.schema.array(
      tool.schema.object({ path: tool.schema.string(), description: tool.schema.string() })
    ).optional().describe('update：新增文件'),
    files_to_remove: tool.schema.array(tool.schema.string()).optional().describe('update：按 path 移除文件'),
    files_to_update: tool.schema.array(
      tool.schema.object({ path: tool.schema.string(), description: tool.schema.string() })
    ).optional().describe('update：按 path 更新文件 description'),
    module_name: tool.schema.string().optional().describe('bind_module：绑定到的模块名'),
    module_description: tool.schema.string().optional().describe('bind_module：新建模块时的模块描述'),
    agent_profile_content: tool.schema.string().optional().describe('bind_module：新建模块时的 agent_profile 内容'),
    responsibilities: tool.schema.array(tool.schema.string()).optional().describe('bind_module：新建模块时的职责列表'),
    functions: tool.schema.array(
      tool.schema.object({ name: tool.schema.string(), description: tool.schema.string() })
    ).optional().describe('bind_module：新建模块时的功能列表'),
  },
  async execute(args, context): Promise<ToolResult> {
    const mode = getAgentMode(context.directory, context.sessionID)
    if (mode !== 'lishou') {
      return {
        title: '权限不足',
        output: JSON.stringify({ status: 'error', error: 'module_classification 仅供隶首调用。' }),
      }
    }

    const directory = context.directory
    const action = args.action as string
    const sessionId = context.sessionID

    try {
      if (action === 'add') {
        const data = await readData(directory, sessionId)
        const dirPath = (args.directory_path as string) ?? data.directory
        data.directory = dirPath

        const newEntries = (args.classifications as {
          name: string
          files: { path: string; description: string }[]
        }[]) ?? []

        for (const entry of newEntries) {
          data.classifications.push({
            name: entry.name,
            files: entry.files,
            bound_module: null,
            is_new_module: false,
          })
        }

        await writeData(directory, sessionId, data)

        return {
          title: `已添加 ${newEntries.length} 个分类`,
          output: JSON.stringify({ status: 'ok', added: newEntries.length, total: data.classifications.length }),
        }
      }

      if (action === 'update') {
        const classificationName = args.classification_name as string
        const data = await readData(directory, sessionId)
        const idx = data.classifications.findIndex(c => c.name === classificationName)
        if (idx === -1) {
          return {
            title: '分类不存在',
            output: JSON.stringify({ status: 'error', error: `分类 '${classificationName}' 不存在。` }),
          }
        }

        const entry = data.classifications[idx]

        const newName = args.name as string | undefined
        if (newName !== undefined && newName !== classificationName) {
          if (data.classifications.some(c => c.name === newName)) {
            return {
              title: '分类名冲突',
              output: JSON.stringify({ status: 'error', error: `分类名 '${newName}' 已存在。` }),
            }
          }
          entry.name = newName
        }

        const filesToAdd = args.files_to_add as { path: string; description: string }[] | undefined
        if (filesToAdd) {
          const existingPaths = new Set(entry.files.map(f => f.path))
          for (const f of filesToAdd) {
            if (!existingPaths.has(f.path)) {
              entry.files.push(f)
              existingPaths.add(f.path)
            }
          }
        }

        const filesToRemove = args.files_to_remove as string[] | undefined
        if (filesToRemove) {
          const removeSet = new Set(filesToRemove)
          entry.files = entry.files.filter(f => !removeSet.has(f.path))
        }

        const filesToUpdate = args.files_to_update as { path: string; description: string }[] | undefined
        if (filesToUpdate) {
          const updateMap = new Map(filesToUpdate.map(f => [f.path, f.description]))
          entry.files = entry.files.map(f => {
            if (updateMap.has(f.path)) {
              return { path: f.path, description: updateMap.get(f.path)! }
            }
            return f
          })
        }

        await writeData(directory, sessionId, data)

        return {
          title: `分类已更新`,
          output: JSON.stringify({ status: 'ok', classification_name: entry.name, file_count: entry.files.length }),
        }
      }

      if (action === 'delete') {
        const classificationName = args.classification_name as string
        const data = await readData(directory, sessionId)
        const len = data.classifications.length
        data.classifications = data.classifications.filter(c => c.name !== classificationName)
        if (data.classifications.length === len) {
          return {
            title: '分类不存在',
            output: JSON.stringify({ status: 'error', error: `分类 '${classificationName}' 不存在。` }),
          }
        }

        await writeData(directory, sessionId, data)

        return {
          title: '分类已删除',
          output: JSON.stringify({ status: 'ok', classification_name: classificationName }),
        }
      }

      if (action === 'bind_module') {
        const classificationName = args.classification_name as string
        const moduleName = args.module_name as string
        if (!moduleName) {
          return {
            title: '参数错误',
            output: JSON.stringify({ status: 'error', error: 'module_name 必填' }),
          }
        }

        const data = await readData(directory, sessionId)
        const entry = data.classifications.find(c => c.name === classificationName)
        if (!entry) {
          return {
            title: '分类不存在',
            output: JSON.stringify({ status: 'error', error: `分类 '${classificationName}' 不存在。` }),
          }
        }

        const existingModule = await findModule(directory, moduleName)
        let isNewModule = false

        if (!existingModule) {
          const moduleDescription = args.module_description as string | undefined
          const agentProfileContent = args.agent_profile_content as string | undefined
          if (!moduleDescription || !agentProfileContent) {
            return {
              title: '参数不足',
              output: JSON.stringify({ status: 'error', error: '新建模块需要 module_description 和 agent_profile_content。' }),
            }
          }

          const agentDir = moduleAgentDir(directory, moduleName)
          const resultsDir = join(agentDir, EXECUTION_RESULTS_DIR)
          await mkdir(agentDir, { recursive: true })
          await mkdir(resultsDir, { recursive: true })

          await writeText(join(agentDir, AGENT_PROFILE_FILE), agentProfileContent)
          await writeText(join(agentDir, CURRENT_SPEC_FILE), defaultCurrentSpec(moduleName))
          await writeText(join(agentDir, CHANGE_HISTORY_FILE), INITIAL_CHANGE_HISTORY)

          await addModule(directory, { name: moduleName, description: moduleDescription })

          const responsibilities = args.responsibilities as string[] | undefined
          const functions = args.functions as { name: string; description: string }[] | undefined
          await addOrUpdateModule(directory, {
            name: moduleName,
            description: moduleDescription,
            responsibilities,
            functions,
          }, false)

          isNewModule = true
        }

        entry.bound_module = moduleName
        entry.is_new_module = isNewModule

        await writeData(directory, sessionId, data)

        return {
          title: `已绑定到模块 '${moduleName}'`,
          output: JSON.stringify({ status: 'ok', classification_name: classificationName, module_name: moduleName, is_new_module: isNewModule }),
        }
      }

      if (action === 'apply') {
        const classificationName = args.classification_name as string | undefined
        const data = await readData(directory, sessionId)

        const targets = classificationName
          ? data.classifications.filter(c => c.name === classificationName && c.bound_module !== null)
          : data.classifications.filter(c => c.bound_module !== null)

        if (targets.length === 0) {
          return {
            title: '无可 apply 的分类',
            output: JSON.stringify({ status: 'ok', message: '没有已绑定模块的分类。' }),
          }
        }

        const summary: { module_name: string; files_added: number }[] = []
        const appliedNames: string[] = []

        for (const entry of targets) {
          const currentDef = await readModuleDefinition(directory, entry.bound_module!)
          const existingPaths = new Set(currentDef.files.map(f => f.path))

          const newFiles = entry.files.filter(f => !existingPaths.has(f.path))

          if (newFiles.length > 0) {
            await writeModuleDefinition(directory, entry.bound_module!, {
              module_name: entry.bound_module!,
              files: [
                ...currentDef.files,
                ...newFiles.map(f => ({ path: f.path, description: f.description })),
              ],
            })
          }

          summary.push({ module_name: entry.bound_module!, files_added: newFiles.length })
          appliedNames.push(entry.name)
        }

        data.classifications = data.classifications.filter(c => !appliedNames.includes(c.name))
        await writeData(directory, sessionId, data)

        return {
          title: `已 apply ${targets.length} 个分类`,
          output: JSON.stringify({ status: 'ok', applied_count: targets.length, summary }),
        }
      }

      return {
        title: '未知操作',
        output: JSON.stringify({ status: 'error', error: `未知 action: ${action}` }),
      }
    } catch (err) {
      return {
        title: '执行错误',
        output: JSON.stringify({ status: 'error', error: (err as Error).message }),
      }
    }
  },
})
