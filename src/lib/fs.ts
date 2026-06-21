import { access, readFile, writeFile } from 'node:fs/promises'

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function readText(path: string): Promise<string> {
  return readFile(path, 'utf-8')
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf-8'))
}

export async function writeText(path: string, content: string): Promise<void> {
  await writeFile(path, content)
}
