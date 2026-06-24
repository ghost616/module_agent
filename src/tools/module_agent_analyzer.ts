import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { tool } from '@opencode-ai/plugin'
import type { ToolResult } from '@opencode-ai/plugin'
import { getAgentMode } from '../lib/session_state.ts'

interface FileMatches {
  path: string
  matches: { line: number; content: string }[]
  error?: string
}

export const moduleAgentAnalyzer = tool({
  description: '根据关键字匹配文件中符合条件的行，返回匹配行号与内容。支持批量文件。',
  args: {
    file_paths: tool.schema.array(tool.schema.string()).describe('文件相对路径列表'),
    keywords: tool.schema.array(tool.schema.string()).describe('匹配关键字列表'),
    case_sensitive: tool.schema.boolean().optional().describe('区分大小写，默认 true'),
    regex: tool.schema.boolean().optional().describe('是否为正则匹配，默认 false'),
  },
  async execute(args, context): Promise<ToolResult> {
    const mode = getAgentMode(context.directory, context.sessionID)
    if (mode !== 'lishou' && mode !== 'fengzhou') {
      return {
        title: '权限不足',
        output: JSON.stringify({ status: 'error', error: 'module_agent_analyzer 仅供隶首或风后调用。' }),
      }
    }

    const filePaths = args.file_paths as string[]
    const keywords = args.keywords as string[]
    const caseSensitive = (args.case_sensitive as boolean) ?? true
    const isRegex = (args.regex as boolean) ?? false

    const patterns = keywords.map(k => {
      if (isRegex) return new RegExp(k, caseSensitive ? '' : 'i')
      const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(escaped, caseSensitive ? '' : 'i')
    })

    const results: FileMatches[] = []
    let totalMatches = 0

    for (const filePath of filePaths) {
      const absPath = join(context.directory, filePath)

      let content: string
      try {
        content = await readFile(absPath, 'utf-8')
      } catch {
        results.push({ path: filePath, matches: [], error: `文件不存在` })
        continue
      }

      const lines = content.split('\n')
      const matches: { line: number; content: string }[] = []

      for (let i = 0; i < lines.length; i++) {
        const lineContent = lines[i].trim()
        if (!lineContent) continue
        for (const pattern of patterns) {
          if (pattern.test(lineContent)) {
            matches.push({ line: i + 1, content: lines[i] })
            break
          }
        }
      }

      results.push({ path: filePath, matches })
      totalMatches += matches.length
    }

    return {
      title: `${filePaths.length} 个文件 (${totalMatches} 行匹配)`,
      output: JSON.stringify({ status: 'ok', results }),
    }
  },
})
