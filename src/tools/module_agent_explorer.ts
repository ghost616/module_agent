import { join, relative, isAbsolute } from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import { tool } from '@opencode-ai/plugin'
import type { ToolResult } from '@opencode-ai/plugin'
import { getAgentMode } from '../lib/session_state.ts'
import { findModulesByFilePath } from '../lib/module_definition.ts'

const DEFAULT_IGNORE = ['node_modules', '.git', '.module_agent', 'dist', 'build', '__pycache__', '.next', '.nuxt']

interface DirEntry {
  path: string
  type: 'file' | 'dir'
  module: string | null
  children_count: number
}

async function countChildren(absPath: string, ignore: string[]): Promise<number> {
  const ignoreSet = new Set(ignore)
  let count = 0
  const entries = await readdir(absPath, { withFileTypes: true })
  for (const e of entries) {
    if (e.isDirectory() && ignoreSet.has(e.name)) continue
    count++
  }
  return count
}

async function scanDir(
  absPath: string,
  directory: string,
  ignore: string[],
  ignoreSet: Set<string>,
  recursive: boolean,
): Promise<DirEntry[]> {
  const entries = await readdir(absPath, { withFileTypes: true })
  const result: DirEntry[] = []

  for (const entry of entries) {
    if (entry.isDirectory() && ignoreSet.has(entry.name)) continue

    const relPath = relative(directory, join(absPath, entry.name)).replace(/\\/g, '/')
    const type: 'file' | 'dir' = entry.isDirectory() ? 'dir' : 'file'

    let module: string | null = null
    if (type === 'file') {
      const modules = await findModulesByFilePath(directory, relPath)
      module = modules.length > 0 ? modules[0] : null
    }

    const childrenCount = type === 'dir'
      ? await countChildren(join(absPath, entry.name), ignore)
      : 0

    result.push({ path: relPath, type, module, children_count: childrenCount })

    if (recursive && type === 'dir') {
      const subEntries = await scanDir(
        join(absPath, entry.name),
        directory,
        ignore,
        ignoreSet,
        true,
      )
      result.push(...subEntries)
    }
  }

  return result
}

export const moduleAgentExplorer = tool({
  description: '获取指定目录下的子目录和子文件列表，包含文件类型、所属模块、子文件数量信息。支持递归扫描。',
  args: {
    directory_path: tool.schema.string().describe('要探索的目录路径（相对或绝对路径）'),
    recursive: tool.schema.boolean().optional().describe('是否递归列出所有层级，默认 false'),
    ignore: tool.schema.array(tool.schema.string()).optional()
      .describe(`要忽略的目录名，默认 ${JSON.stringify(DEFAULT_IGNORE)}`),
  },
  async execute(args, context): Promise<ToolResult> {
    const mode = getAgentMode(context.directory, context.sessionID)
    if (mode !== 'lishou' && mode !== 'fengzhou') {
      return {
        title: '权限不足',
        output: JSON.stringify({ status: 'error', error: 'module_agent_explorer 仅供隶首或风后调用。' }),
      }
    }

    const directory = context.directory
    let rawPath = args.directory_path as string
    const recursive = (args.recursive as boolean) ?? false
    const ignore = (args.ignore as string[]) ?? DEFAULT_IGNORE
    const ignoreSet = new Set(ignore)

    if (isAbsolute(rawPath)) {
      rawPath = relative(directory, rawPath).replace(/\\/g, '/')
    }

    const absDirPath = join(directory, rawPath)

    try {
      const st = await stat(absDirPath)
      if (!st.isDirectory()) {
        return {
          title: '路径不是目录',
          output: JSON.stringify({ status: 'error', error: `${rawPath} 不是目录。` }),
        }
      }
    } catch {
      return {
        title: '目录不存在',
        output: JSON.stringify({ status: 'error', error: `目录 ${rawPath} 不存在。` }),
      }
    }

    const result = await scanDir(absDirPath, directory, ignore, ignoreSet, recursive)

    return {
      title: `${rawPath} (${result.length} 个条目)`,
      output: JSON.stringify({ status: 'ok', directory: rawPath, entries: result }),
    }
  },
})
