import { tool } from '@opencode-ai/plugin'
import type { ToolResult } from '@opencode-ai/plugin'
import type { OpencodeClient } from '@opencode-ai/sdk'
import { SETUP_GUIDE } from '../lib/setup_guide.ts'
import { getAgentMode, setAgentMode } from '../lib/session_state.ts'

export function createModuleAgentSetup(client: OpencodeClient) {
  return tool({
    description:
      '启动岐伯项目设置向导，注入设置规则。CRITICAL：若风后力牧（module_agent_start）已激活则禁止使用——风后力牧与岐伯互斥，同一会话只能激活其一。仅在风后力牧未激活时可用。',
    args: {},
    async execute(_args, context): Promise<ToolResult> {
      const current = getAgentMode(context.directory, context.sessionID)
      if (current === 'fengzhou') {
        return {
          title: '加载失败',
          output: '风后力牧已在此会话中激活。岐伯与风后力牧互斥，无法同时加载。请在新会话中加载岐伯。',
        }
      }
      if (current === 'limu') {
        return {
          title: '加载失败',
          output: '力牧已在此会话中激活，无法启动岐伯。请在新会话中操作。',
        }
      }
      if (current === 'gaotao') {
        return {
          title: '加载失败',
          output: '皋陶已在此会话中激活，无法启动岐伯。请在新会话中操作。',
        }
      }

      setAgentMode(context.directory, context.sessionID, 'qibo')

      await client.session.prompt({
        path: { id: context.sessionID },
        body: {
          noReply: true,
          parts: [{ type: 'text', text: SETUP_GUIDE }],
        },
      })

      await client.app.log({
        body: {
          service: 'module-agent-plugin',
          level: 'info',
          message: 'Setup guide injected into session',
          extra: { sessionID: context.sessionID },
        },
      })

      return {
        title: '岐伯已启动',
        output: '岐伯已注入当前会话，AI 将引导你逐步完成代码规范、需求设计和模块设计。',
      }
    },
  })
}
