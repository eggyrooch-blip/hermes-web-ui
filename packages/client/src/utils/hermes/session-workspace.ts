/**
 * A session's workspace binding, as the UI is allowed to read it.
 *
 * `sessions.workspace` predates this feature: the old broker stamped every session
 * that ever ran with the ABSOLUTE host path of the profile workspace root, and the
 * old admin picker stored absolute host paths verbatim. Those rows are not user
 * bindings — showing them would put a 📁 label on nearly every historical session
 * and invent a phantom sidebar group on the day this ships. Only a relative path,
 * which is the one shape the new contract persists, counts as an explicit binding.
 * The server rewrites legacy rows to null on their next run; this keeps the UI
 * honest until then.
 */
export function explicitSessionWorkspace(workspace?: string | null): string | null {
  const value = (workspace || '').trim()
  if (!value) return null
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value)) return null
  return value
}

/** Folder name to show for a binding, e.g. `a/b/work` → `work`. */
export function sessionWorkspaceLabel(workspace?: string | null): string {
  const value = explicitSessionWorkspace(workspace)
  if (!value) return ''
  return value.split('/').filter(Boolean).pop() || ''
}
