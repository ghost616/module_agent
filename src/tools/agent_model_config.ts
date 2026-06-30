import { tool } from '@opencode-ai/plugin'
import type { ToolResult } from '@opencode-ai/plugin'
import { getAgentMode } from '../lib/session_state.ts'
import { getBoundWorkspace, getWorkspaceDir } from '../lib/workspace.ts'
import { readAgentModelConfig, writeAgentModelConfig } from '../lib/agent_model_config.ts'
import type { AgentModelEntry } from '../lib/agent_model_config.ts'

export const agentModelConfig = tool({
  description: '管理当前工作空间中力牧和皋陶的默认模型配置。仅风后可调用，需已绑定工作空间。',
  args: {
    action: tool.schema.enum(['get', 'set']).describe('get=查看当前配置，set=设置默认模型'),
    limu_provider_id: tool.schema.string().optional().describe('力牧使用的模型提供方 ID（action=set 时使用）'),
    limu_model_id: tool.schema.string().optional().describe('力牧使用的模型 ID（action=set 时使用）'),
    gaotao_provider_id: tool.schema.string().optional().describe('皋陶使用的模型提供方 ID（action=set 时使用）'),
    gaotao_model_id: tool.schema.string().optional().describe('皋陶使用的模型 ID（action=set 时使用）'),
  },
  async execute(args, context): Promise<ToolResult> {
    if (getAgentMode(context.directory, context.sessionID) !== 'fengzhou') {
      return {
        title: '权限不足',
        output: JSON.stringify({ status: 'error', error: 'agent_model_config 仅供风后调用。' }),
      }
    }

    const directory = context.directory
    const sessionId = context.sessionID
    const action = args.action as string

    const boundWs = await getBoundWorkspace(directory, sessionId)
    if (!boundWs) {
      return {
        title: '未绑定工作空间',
        output: JSON.stringify({ status: 'error', error: '请先通过 workspace(action="create"|"bind") 绑定工作空间' }),
      }
    }
    const workspaceDir = getWorkspaceDir(directory, boundWs)

    try {
      if (action === 'get') {
        const config = await readAgentModelConfig(workspaceDir)
        return {
          title: config ? '当前模型配置' : '未配置模型',
          output: JSON.stringify({ status: 'ok', config }),
        }
      }

      if (action === 'set') {
        const existing = await readAgentModelConfig(workspaceDir) ?? {}

        const limuProviderId = args.limu_provider_id as string | undefined
        const limuModelId = args.limu_model_id as string | undefined
        const gaotaoProviderId = args.gaotao_provider_id as string | undefined
        const gaotaoModelId = args.gaotao_model_id as string | undefined

        if (
          (!limuProviderId && !limuModelId && !gaotaoProviderId && !gaotaoModelId)
        ) {
          return {
            title: '参数不足',
            output: JSON.stringify({ status: 'error', error: 'set 至少需要设置 limu 或 gaotao 的模型参数' }),
          }
        }

        if (limuProviderId || limuModelId) {
          if (!limuProviderId || !limuModelId) {
            return {
              title: '参数错误',
              output: JSON.stringify({ status: 'error', error: '设置力牧模型需同时提供 limu_provider_id 和 limu_model_id' }),
            }
          }
          existing.limu = { providerID: limuProviderId, modelID: limuModelId }
        }

        if (gaotaoProviderId || gaotaoModelId) {
          if (!gaotaoProviderId || !gaotaoModelId) {
            return {
              title: '参数错误',
              output: JSON.stringify({ status: 'error', error: '设置皋陶模型需同时提供 gaotao_provider_id 和 gaotao_model_id' }),
            }
          }
          existing.gaotao = { providerID: gaotaoProviderId, modelID: gaotaoModelId }
        }

        await writeAgentModelConfig(workspaceDir, existing)

        return {
          title: '模型配置已更新',
          output: JSON.stringify({ status: 'ok', config: existing }),
        }
      }

      return { title: '未知操作', output: JSON.stringify({ status: 'error', error: `未知 action: ${action}` }) }
    } catch (err) {
      return { title: '模型配置错误', output: JSON.stringify({ status: 'error', error: (err as Error).message }) }
    }
  },
})
