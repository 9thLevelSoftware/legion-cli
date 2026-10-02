export {
  buildMcpSpawnEnv,
  closeMcpTransports,
  createMcpClientTransport,
  LegionMcpClientPool,
  MCP_CONNECT_TIMEOUT_MS,
  MCP_ENV_ALLOWLIST,
  MCP_POOL_MAX,
  MCP_REMOTE_MAX_RESPONSE_BYTES,
  MCP_TOOL_TIMEOUT_MS,
  McpClientError,
  validateMcpRemoteUrl,
} from "@9thlevelsoftware/legion-cli-http";
export type {
  ExternalMcpTool,
  LegionMcpClientPoolOptions,
  McpFailReason,
  McpLookup,
  ToolCallResult,
} from "@9thlevelsoftware/legion-cli-http";
