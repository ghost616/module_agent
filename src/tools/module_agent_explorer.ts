import { join, relative, isAbsolute, basename, extname } from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import { tool } from '@opencode-ai/plugin'
import type { ToolResult } from '@opencode-ai/plugin'
import { getAgentMode } from '../lib/session_state.ts'
import { findModulesByFilePath } from '../lib/module_definition.ts'

const DEFAULT_IGNORE = ['node_modules', '.git', '.module_agent', 'dist', 'build', 'target', '__pycache__', '.next', '.nuxt']

interface DirEntry {
  path: string
  type: 'dir'
  children_count: number
  bound_module_stats: Record<string, { file_count: number }>
  file_type_stats: { files: Record<string, number>; directories: number }
}

interface FileItem {
  name: string
  module: string | null
}

interface TreeNode {
  name: string
  path: string
  children?: TreeNode[]
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

function formatTree(nodes: TreeNode[], prefix: string = ''): string {
  let result = ''
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    const isLast = i === nodes.length - 1
    const connector = isLast ? '└── ' : '├── '
    const childPrefix = isLast ? '    ' : '│   '

    result += `${prefix}${connector}${node.name}/\n`

    if (node.children && node.children.length > 0) {
      result += formatTree(node.children, prefix + childPrefix)
    }
  }
  return result
}

async function computeDirStatsAsync(
  absPath: string,
  directory: string,
  ignoreSet: Set<string>,
): Promise<{
  bound_module_stats: Record<string, { file_count: number }>
  file_type_stats: { files: Record<string, number>; directories: number }
}> {
  const boundModuleStats: Record<string, { file_count: number }> = {}
  const fileTypeFiles: Record<string, number> = {}
  let directories = 0

  const entries = await readdir(absPath, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (ignoreSet.has(entry.name)) continue
      directories++
    } else {
      const relPath = relative(directory, join(absPath, entry.name)).replace(/\\/g, '/')
      const modules = await findModulesByFilePath(directory, relPath)
      const moduleKey = modules.length > 0 ? modules[0] : 'unbound'
      if (!boundModuleStats[moduleKey]) {
        boundModuleStats[moduleKey] = { file_count: 0 }
      }
      boundModuleStats[moduleKey].file_count++

      const ext = extname(relPath).toLowerCase()
      const key = ext || 'other'
      fileTypeFiles[key] = (fileTypeFiles[key] ?? 0) + 1
    }
  }

  return {
    bound_module_stats: boundModuleStats,
    file_type_stats: { files: fileTypeFiles, directories },
  }
}

async function buildTree(
  absPath: string,
  directory: string,
  ignoreSet: Set<string>,
): Promise<TreeNode[]> {
  const entries = await readdir(absPath, { withFileTypes: true })
  const tree: TreeNode[] = []

  for (const entry of entries) {
    if (!entry.isDirectory() || ignoreSet.has(entry.name)) continue

    const relPath = relative(directory, join(absPath, entry.name)).replace(/\\/g, '/')
    const node: TreeNode = { name: entry.name, path: relPath }

    const children = await buildTree(join(absPath, entry.name), directory, ignoreSet)
    if (children.length === 0) {
      const stats = await computeDirStatsAsync(join(absPath, entry.name), directory, ignoreSet)
      const totalFiles = Object.values(stats.bound_module_stats)
        .reduce((sum, s) => sum + s.file_count, 0)
      if (totalFiles === 0) continue
    }
    if (children.length > 0) {
      node.children = children
    }

    tree.push(node)
  }

  return tree
}

export const moduleAgentExplorer = tool({
  description: '获取指定目录下的子目录和子文件列表，包含文件类型、所属模块、子文件数量信息。支持递归扫描。',
  args: {
    action: tool.schema.enum(['explore_dir', 'list_files']).describe('操作类型：explore_dir 获取子目录列表及统计信息，list_files 获取目录下的直接子文件（不含子目录）'),
    directory_path: tool.schema.string().optional().describe('explore_dir：要探索的目录路径（相对或绝对路径）'),
    directory_paths: tool.schema.array(tool.schema.string()).optional().describe('list_files：子目录路径列表'),
    recursive: tool.schema.boolean().optional().describe('explore_dir：是否递归列出目录树（默认 false），统计信息仍只含直接子目录'),
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

    const action = args.action as string
    const directory = context.directory
    const ignore = (args.ignore as string[]) ?? DEFAULT_IGNORE
    const ignoreSet = new Set(ignore)

    if (action === 'list_files') {
      const dirPaths = args.directory_paths as string[]
      if (!dirPaths || dirPaths.length === 0) {
        return {
          title: '参数错误',
          output: JSON.stringify({ status: 'error', error: 'directory_paths 必填。' }),
        }
      }

      const files: Record<string, FileItem[]> = {}

      for (const dirPath of dirPaths) {
        const absDirPath = join(directory, dirPath)

        try {
          const st = await stat(absDirPath)
          if (!st.isDirectory()) continue
        } catch {
          continue
        }

        const dirFiles: FileItem[] = []

        async function collectFiles(absDir: string) {
          const entries = await readdir(absDir, { withFileTypes: true })
          for (const entry of entries) {
            if (entry.isDirectory()) continue
            const relPath = relative(directory, join(absDir, entry.name)).replace(/\\/g, '/')
            const modules = await findModulesByFilePath(directory, relPath)
            dirFiles.push({
              name: entry.name,
              module: modules.length > 0 ? modules[0] : null,
            })
          }
        }

        await collectFiles(absDirPath)
        if (dirFiles.length > 0) {
          files[dirPath] = dirFiles
        }
      }

      return {
        title: `${dirPaths.length} 个目录`,
        output: JSON.stringify({ status: 'ok', files }),
      }
    }

    let rawPath = args.directory_path as string
    const recursive = (args.recursive as boolean) ?? false

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

    const dirEntries: DirEntry[] = []

    async function collectDirs(absDir: string, parentRelPath: string) {
      const entries = await readdir(absDir, { withFileTypes: true })

      for (const entry of entries) {
        if (!entry.isDirectory() || ignoreSet.has(entry.name)) continue

        const relPath = relative(directory, join(absDir, entry.name)).replace(/\\/g, '/')
        const childrenCount = await countChildren(join(absDir, entry.name), ignore)
        const stats = await computeDirStatsAsync(join(absDir, entry.name), directory, ignoreSet)

        const totalFiles = Object.values(stats.bound_module_stats)
          .reduce((sum, s) => sum + s.file_count, 0)

        if (totalFiles > 0) {
          dirEntries.push({
            path: relPath,
            type: 'dir',
            children_count: childrenCount,
            bound_module_stats: stats.bound_module_stats,
            file_type_stats: stats.file_type_stats,
          })
        }

        if (recursive) {
          await collectDirs(join(absDir, entry.name), relPath)
        }
      }
    }

    await collectDirs(absDirPath, rawPath)

    const mainTree = await buildTree(absDirPath, directory, ignoreSet)
    const dirName = basename(rawPath) || rawPath
    const treeText = `${dirName}/\n${formatTree(mainTree)}`

    return {
      title: `${rawPath} (${dirEntries.length} 个子目录)`,
      output: JSON.stringify({
        status: 'ok',
        directory: rawPath,
        entries: dirEntries,
        tree_text: treeText,
      }),
    }
  },
})
