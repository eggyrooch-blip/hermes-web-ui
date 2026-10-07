export type MessageViewportScrollSnapshot = {
  anchorMessageId: string | null;
  anchorOffset: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  wasNearBottom: boolean;
}

type MessageScrollSession = {
  id: string;
  profile?: string | null;
}

/**
 * Scroll snapshots are keyed by scope + profile + session so the same session id
 * seen from chat, history, kanban or workflow never shares a stored position.
 */
export function messageScrollPositionKey(
  scope: string,
  session: MessageScrollSession | null | undefined,
): string | null {
  const sessionId = String(session?.id || "").trim();
  if (!sessionId) return null;
  const normalizedScope = scope.trim() || "default";
  const profile = String(session?.profile || "default").trim() || "default";
  return `${normalizedScope}\u0000${profile}\u0000${sessionId}`;
}

/**
 * Insert (or refresh) a snapshot, keeping the map bounded and LRU-ordered:
 * re-inserting moves the key to the newest slot, and the oldest keys are evicted.
 */
export function rememberMessageScrollPosition(
  positions: Map<string, MessageViewportScrollSnapshot>,
  key: string,
  snapshot: MessageViewportScrollSnapshot,
  maxEntries = 200,
) {
  positions.delete(key);
  positions.set(key, snapshot);
  while (positions.size > maxEntries) {
    const oldestKey = positions.keys().next().value;
    if (oldestKey === undefined) break;
    positions.delete(oldestKey);
  }
}
