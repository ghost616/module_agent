import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { exists, readJson, writeText } from './fs.ts'

export interface AgentModelEntry {
  providerID: string
  modelID: string
}

export interface AgentModelConfig {
  limu?: AgentModelEntry
  gaotao?: AgentModelEntry
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
