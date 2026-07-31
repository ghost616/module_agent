import { join } from 'node:path'
import { workspaceDir } from './constants.ts'
import { exists, readJson, writeText } from './fs.ts'

export interface WorkspaceConfig {
  development_mode: 'beginner' | 'expert' | ''
}

const CONFIG_FILE = 'config.json'

function configPath(directory: string, workspaceName: string): string {
  return join(workspaceDir(directory, workspaceName), CONFIG_FILE)
}

const DEFAULT_CONFIG: WorkspaceConfig = {
  development_mode: '',
}

export async function getWorkspaceConfig(directory: string, workspaceName: string): Promise<WorkspaceConfig> {
  const path = configPath(directory, workspaceName)
  if (!(await exists(path))) return { ...DEFAULT_CONFIG }
  try {
    return await readJson<WorkspaceConfig>(path)
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export async function setWorkspaceConfig(directory: string, workspaceName: string, config: WorkspaceConfig): Promise<void> {
  const path = configPath(directory, workspaceName)
  await writeText(path, JSON.stringify(config, null, 2))
}

export async function setDevelopmentMode(directory: string, workspaceName: string, mode: 'beginner' | 'expert'): Promise<void> {
  const config = await getWorkspaceConfig(directory, workspaceName)
  config.development_mode = mode
  await setWorkspaceConfig(directory, workspaceName, config)
}
