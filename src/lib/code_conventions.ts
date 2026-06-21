import { join } from 'node:path'
import { MODULE_AGENT_DIR, CODE_CONVENTIONS_FILE } from './constants.ts'
import { exists, readText } from './fs.ts'

export async function readCodeConventions(directory: string): Promise<string> {
  const path = join(directory, MODULE_AGENT_DIR, CODE_CONVENTIONS_FILE)
  if (!(await exists(path))) {
    return ''
  }
  return readText(path)
}
