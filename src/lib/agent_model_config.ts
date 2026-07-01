import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { OpencodeClient } from '@opencode-ai/sdk'
import { exists, readJson, writeText } from './fs.ts'

export interface AgentModelEntry {
  providerID: string
  modelID: string
}

export interface AgentModelConfig {
  limu?: AgentModelEntry
  gaotao?: AgentModelEntry
  lizhu?: AgentModelEntry
}

export interface ModelValidationError {
  agent: 'limu' | 'gaotao' | 'lizhu'
  error: string
}

const FILE_NAME = 'agent_model_config.json'

function configPath(workspaceDir: string): string {
  return join(workspaceDir, FILE_NAME)
}

export async function readAgentModelConfig(workspaceDir: string): Promise<AgentModelConfig | null> {
  const path = configPath(workspaceDir)
  if (!(await exists(path))) return null
  try {
    return await readJson<AgentModelConfig>(path)
  } catch {
    return null
  }
}

export async function writeAgentModelConfig(workspaceDir: string, config: AgentModelConfig): Promise<void> {
  const path = configPath(workspaceDir)
  await mkdir(workspaceDir, { recursive: true })
  await writeText(path, JSON.stringify(config, null, 2))
}

export async function validateModelConfig(
  client: OpencodeClient,
  config: AgentModelConfig,
): Promise<ModelValidationError[]> {
  const result = await client.config.providers()
  if (result.error || !result.data) return []

  const providers = result.data.providers
  const errors: ModelValidationError[] = []

  const agents: Array<{ key: 'limu' | 'gaotao' | 'lizhu'; entry: AgentModelEntry | undefined; label: string }> = [
    { key: 'limu', entry: config.limu, label: '力牧' },
    { key: 'gaotao', entry: config.gaotao, label: '皋陶' },
    { key: 'lizhu', entry: config.lizhu, label: '离朱' },
  ]

  for (const { key, entry, label } of agents) {
    if (!entry) {
      errors.push({ agent: key, error: `缺少 ${label} 默认模型配置` })
      continue
    }

    const provider = providers.find(p => p.id === entry.providerID)
    if (!provider) {
      errors.push({ agent: key, error: `模型提供方 '${entry.providerID}' 未在当前配置中找到` })
      continue
    }

    const model = provider.models[entry.modelID]
    if (!model) {
      const availableModels = Object.keys(provider.models).join(', ')
      errors.push({ agent: key, error: `模型 '${entry.modelID}' 未在提供方 '${entry.providerID}' 中找到。可用模型: ${availableModels}` })
    }
  }

  return errors
}
