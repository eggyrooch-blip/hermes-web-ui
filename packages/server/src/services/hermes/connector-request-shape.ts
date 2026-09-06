export function connectorRequestHasOnly(
  query: unknown,
  body: unknown,
  allowedQuery: readonly string[],
  allowedBody: readonly string[],
): boolean {
  const valid = (value: unknown, allowed: readonly string[]) => value == null || (
    typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).every(key => allowed.includes(key))
  )
  return valid(query, allowedQuery) && valid(body, allowedBody)
}
