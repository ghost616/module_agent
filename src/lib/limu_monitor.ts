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
