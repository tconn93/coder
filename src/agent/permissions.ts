/**
 * Permission gate for destructive tool operations.
 *
 * Permission modes (from AgentOptions.permissionMode):
 *   bypassPermissions — all tools run without restriction
 *   acceptEdits      — write_file/edit_file auto-allowed; bash requires approval
 *   default / plan   — all destructive tools require approval
 */
import type { PermissionMode } from '../types.js';

export interface PermissionCheck {
  allowed: boolean;
  reason?: string;
}

const DESTRUCTIVE_TOOLS = ['bash', 'write_file', 'edit_file'] as const;
type DestructiveTool = (typeof DESTRUCTIVE_TOOLS)[number];

export function isDestructiveTool(toolName: string): toolName is DestructiveTool {
  return DESTRUCTIVE_TOOLS.includes(toolName as DestructiveTool);
}

/**
 * Check whether a destructive tool call is allowed under the given permission mode.
 * Returns { allowed: true } if the operation can proceed, or { allowed: false, reason } if blocked.
 */
export function checkPermission(
  toolName: string,
  mode: PermissionMode,
): PermissionCheck {
  if (mode === 'bypassPermissions') {
    return { allowed: true };
  }

  if (!isDestructiveTool(toolName)) {
    return { allowed: true };
  }

  if (mode === 'acceptEdits') {
    // File edits are auto-accepted; bash still requires explicit approval
    if (toolName === 'write_file' || toolName === 'edit_file') {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `bash requires approval in 'acceptEdits' mode. Use write_file/edit_file for changes, or switch to bypassPermissions for unrestricted bash access.`,
    };
  }

  // default / plan — block all destructive tools
  return {
    allowed: false,
    reason: `Tool '${toolName}' is blocked in '${mode}' permission mode. Switch to 'acceptEdits' to allow file edits, or 'bypassPermissions' to allow all operations.`,
  };
}
