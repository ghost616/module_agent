import { tool } from '@opencode-ai/plugin'
import type { ToolResult } from '@opencode-ai/plugin'
import type { OpencodeClient } from '@opencode-ai/sdk'

export function createAgentModelList(client: OpencodeClient) {
  return tool({
    description: '获取当前配置的模型提供方和可用模型列表。返回所有已配置的 provider 及其支持的 model。',
    args: {},
    async execute(_args, _context): Promise<ToolResult> {
      try {
        const result = await client.config.providers()
        if (result.error || !result.data) {
          return {
            title: '获取模型列表失败',
            output: JSON.stringify({ status: 'error', error: result.error ? JSON.stringify(result.error) : '无数据' }),
          }
        }
        return {
          title: `共 ${result.data.providers.length} 个模型提供方`,
          output: JSON.stringify(result.data),
        }
      } catch (err) {
        return {
          title: '获取模型列表异常',
          output: JSON.stringify({ status: 'error', error: (err as Error).message }),
        }
      }
    },
  })
}
