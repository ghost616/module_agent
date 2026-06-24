import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { tool } from '@opencode-ai/plugin'
import type { ToolResult } from '@opencode-ai/plugin'
import { getAgentMode } from '../lib/session_state.ts'

interface RangeInput {
  line: number
  before?: number
  after?: number
}

interface RangeResult {
  line: number
  start: number
  end: number
  lines: { line: number; content: string }[]
}

export const moduleAgentLineReader = tool({
  description: '根据行号范围和上下文读取文件指定行内容。',
  args: {
    file_path: tool.schema.string().describe('文件相对路径'),
    ranges: tool.schema.array(
      tool.schema.object({
        line: tool.schema.number(),
        before: tool.schema.number().optional(),
        after: tool.schema.number().optional(),
      })
    ).describe('读取范围列表：line 基准行号，before 前 N 行（默认 0），after 后 N 行（默认 0）'),
  },
  async execute(args, context): Promise<ToolResult> {
    const mode = getAgentMode(context.directory, context.sessionID)
    if (mode !== 'lishou' && mode !== 'fengzhou') {
      return {
        title: '权限不足',
        output: JSON.stringify({ status: 'error', error: 'module_agent_line_reader 仅供隶首或风后调用。' }),
      }
    }

    const filePath = args.file_path as string
    const ranges = args.ranges as RangeInput[]
    const absPath = join(context.directory, filePath)

    let content: string
    try {
      content = await readFile(absPath, 'utf-8')
    } catch {
      return {
        title: '文件不存在',
        output: JSON.stringify({ status: 'error', error: `文件 ${filePath} 不存在。` }),
      }
    }

    const lines = content.split('\n')
    const totalLines = lines.length
    const results: RangeResult[] = []

    for (const range of ranges) {
      const before = range.before ?? 0
      const after = range.after ?? 0
      const start = Math.max(1, range.line - before)
      const end = Math.min(totalLines, range.line + after)

      const rangeLines: { line: number; content: string }[] = []
      for (let i = start; i <= end; i++) {
        rangeLines.push({ line: i, content: lines[i - 1] })
      }

      results.push({ line: range.line, start, end, lines: rangeLines })
    }

    return {
      title: `${filePath} (${ranges.length} 个区间)`,
      output: JSON.stringify({ status: 'ok', path: filePath, ranges: results }),
    }
  },
})
