let nextSessionIncarnation = 0
const sessionIncarnations = new Map<string, number>()

export function ensureSessionIncarnation(id: string): number {
  const existing = sessionIncarnations.get(id)
  if (existing != null) return existing
  const incarnation = ++nextSessionIncarnation
  sessionIncarnations.set(id, incarnation)
  return incarnation
}

export function renewSessionIncarnation(id: string): number {
  const incarnation = ++nextSessionIncarnation
  sessionIncarnations.set(id, incarnation)
  return incarnation
}

export function currentSessionIncarnation(id: string): number | null {
  return sessionIncarnations.get(id) ?? null
}

export function clearSessionIncarnation(id: string): void {
  sessionIncarnations.delete(id)
}
