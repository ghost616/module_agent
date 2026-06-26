import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { exists, readText, readJson, writeText } from './fs.ts'

export interface PlanMeta {
  plan_id: string
  plan_summary: string
  code_reviewed: boolean
  plan_completed: boolean
}

export interface PlanDetail {
  plan_id: string
  module_name: string
  development_plan: string
  session_id: string
  modified_files: string[]
}

function getPlanDir(workspaceDir: string): string {
  return join(workspaceDir, 'development_plan')
}

function getMetadataPath(workspaceDir: string): string {
  return join(workspaceDir, 'development_plan', 'metadata.json')
}

function getPlanFilePath(workspaceDir: string, planId: string): string {
  return join(workspaceDir, 'development_plan', `${planId}.json`)
}

async function ensureDir(workspaceDir: string): Promise<void> {
  const dir = getPlanDir(workspaceDir)
  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true })
  }
}

export async function readAllMetadata(workspaceDir: string): Promise<PlanMeta[]> {
  const path = getMetadataPath(workspaceDir)
  if (!(await exists(path))) return []
  try {
    return await readJson<PlanMeta[]>(path)
  } catch {
    return []
  }
}

export async function readPlan(workspaceDir: string, planId: string): Promise<PlanDetail | null> {
  const path = getPlanFilePath(workspaceDir, planId)
  if (!(await exists(path))) return null
  try {
    return await readJson<PlanDetail>(path)
  } catch {
    return null
  }
}

export async function savePlan(
  workspaceDir: string,
  planId: string,
  planData: PlanDetail,
  planSummary: string,
): Promise<void> {
  await ensureDir(workspaceDir)

  await writeText(getPlanFilePath(workspaceDir, planId), JSON.stringify(planData, null, 2))

  const metadata = await readAllMetadata(workspaceDir)
  const existing = metadata.findIndex(m => m.plan_id === planId)
  const entry: PlanMeta = {
    plan_id: planId,
    plan_summary: planSummary,
    code_reviewed: false,
    plan_completed: false,
  }
  if (existing >= 0) {
    metadata[existing] = entry
  } else {
    metadata.push(entry)
  }
  await writeText(getMetadataPath(workspaceDir), JSON.stringify(metadata, null, 2))
}

export async function markPlanComplete(
  workspaceDir: string,
  planId: string,
  files: string[],
): Promise<boolean> {
  const plan = await readPlan(workspaceDir, planId)
  if (!plan) return false

  plan.modified_files = files
  await writeText(getPlanFilePath(workspaceDir, planId), JSON.stringify(plan, null, 2))

  const metadata = await readAllMetadata(workspaceDir)
  const entry = metadata.find(m => m.plan_id === planId)
  if (entry) {
    entry.plan_completed = true
    await writeText(getMetadataPath(workspaceDir), JSON.stringify(metadata, null, 2))
  }
  return true
}

export async function getFirstPendingReview(workspaceDir: string): Promise<PlanDetail | null> {
  const metadata = await readAllMetadata(workspaceDir)
  for (const meta of metadata) {
    if (meta.plan_completed && !meta.code_reviewed) {
      return readPlan(workspaceDir, meta.plan_id)
    }
  }
  return null
}

export async function markReviewComplete(workspaceDir: string, planId: string): Promise<boolean> {
  const metadata = await readAllMetadata(workspaceDir)
  const entry = metadata.find(m => m.plan_id === planId)
  if (!entry) return false
  entry.code_reviewed = true
  await writeText(getMetadataPath(workspaceDir), JSON.stringify(metadata, null, 2))
  return true
}

export async function deletePlan(workspaceDir: string, planId: string): Promise<boolean> {
  const planPath = getPlanFilePath(workspaceDir, planId)
  let deleted = false

  if (await exists(planPath)) {
    const { unlink } = await import('node:fs/promises')
    await unlink(planPath)
    deleted = true
  }

  const metadata = await readAllMetadata(workspaceDir)
  const filtered = metadata.filter(m => m.plan_id !== planId)
  if (filtered.length !== metadata.length) {
    await writeText(getMetadataPath(workspaceDir), JSON.stringify(filtered, null, 2))
    deleted = true
  }

  return deleted
}

export async function deleteCompletedPlans(workspaceDir: string): Promise<number> {
  const metadata = await readAllMetadata(workspaceDir)
  let deleted = 0
  for (const meta of metadata) {
    if (meta.plan_completed && meta.code_reviewed) {
      if (await deletePlan(workspaceDir, meta.plan_id)) {
        deleted++
      }
    }
  }
  return deleted
}

export async function cleanStalePlans(
  workspaceDir: string,
  isAlive: (sessionId: string) => Promise<boolean>,
): Promise<string[]> {
  const metadata = await readAllMetadata(workspaceDir)
  const deleted: string[] = []
  for (const meta of metadata) {
    const plan = await readPlan(workspaceDir, meta.plan_id)
    if (!plan) continue
    if (!(await isAlive(plan.session_id))) {
      if (await deletePlan(workspaceDir, meta.plan_id)) {
        deleted.push(meta.plan_id)
      }
    }
  }
  return deleted
}
