import { mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { exists, readJson, writeText } from './fs.ts'

export interface ReviewIssue {
  file: string
  line?: number
  severity: 'error' | 'warning' | 'info'
  message: string
}

export interface PlanReview {
  plan_id: string
  summary: string
  issues: ReviewIssue[]
  approved: boolean
}

export interface ReviewResult {
  reviewer_session_id: string
  planReviews: PlanReview[]
}

function reviewDir(workspaceDir: string): string {
  return join(workspaceDir, 'review_results')
}

function reviewPath(workspaceDir: string, reviewerSessionId: string): string {
  return join(reviewDir(workspaceDir), `${reviewerSessionId}.json`)
}

export async function writeReviewResult(
  workspaceDir: string,
  reviewerSessionId: string,
  result: ReviewResult,
): Promise<void> {
  const dir = reviewDir(workspaceDir)
  await mkdir(dir, { recursive: true })
  await writeText(reviewPath(workspaceDir, reviewerSessionId), JSON.stringify(result, null, 2))
}

export async function readReviewResult(
  workspaceDir: string,
  reviewerSessionId: string,
): Promise<ReviewResult | null> {
  const path = reviewPath(workspaceDir, reviewerSessionId)
  if (!(await exists(path))) return null
  try {
    return await readJson<ReviewResult>(path)
  } catch {
    return null
  }
}

export async function deleteReviewResult(
  workspaceDir: string,
  reviewerSessionId: string,
): Promise<boolean> {
  const path = reviewPath(workspaceDir, reviewerSessionId)
  if (!(await exists(path))) return false
  await unlink(path)
  return true
}
