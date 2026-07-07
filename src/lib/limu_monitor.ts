const lastActivity = new Map<string, number>()

export function recordActivity(sessionId: string): void {
  lastActivity.set(sessionId, Date.now())
}

export function getLastActivity(sessionId: string): number | undefined {
  return lastActivity.get(sessionId)
}

export function isWorking(sessionId: string): boolean {
  return lastActivity.has(sessionId)
}

export function clearActivity(sessionId: string): void {
  lastActivity.delete(sessionId)
}

export interface SessionIdleInfo {
  lastActivity: number | null
  idleSeconds: number | null
  unresponsive: boolean
}

const IDLE_TIMEOUT_MS = 300000

export function getSessionIdle(sessionId: string): SessionIdleInfo {
  const activity = lastActivity.get(sessionId) ?? null
  const idleSeconds = activity ? Math.floor((Date.now() - activity) / 1000) : null
  const unresponsive = idleSeconds === null || idleSeconds > Math.floor(IDLE_TIMEOUT_MS / 1000)
  return { lastActivity: activity, idleSeconds, unresponsive }
}
