const ANTHROPIC_WORKSPACE_HEADER = 'anthropic-workspace-id';

function getAnthropicWorkspaceHeaders(env = process.env) {
  const workspaceId = env.ANTHROPIC_WORKSPACE_ID?.trim();
  return workspaceId ? { [ANTHROPIC_WORKSPACE_HEADER]: workspaceId } : {};
}

module.exports = {
  ANTHROPIC_WORKSPACE_HEADER,
  getAnthropicWorkspaceHeaders,
};
