/** Shared guards for the small client half. */
export function usableSession(sessionId: unknown): sessionId is string {
  return typeof sessionId === 'string' && sessionId.trim().length > 0
}
