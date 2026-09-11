// What a client needs to reach this Worker's MCP endpoint, shared by the panels that show it.

export const MCP_URL = `${location.origin}/mcp`;

export const CONFIG_SNIPPET = JSON.stringify(
  { mcpServers: { workouts: { type: 'http', url: MCP_URL, headers: { Authorization: 'Bearer wk_...' } } } },
  null,
  2,
);
