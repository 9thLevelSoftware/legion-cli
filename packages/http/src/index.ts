export { completionsUrl, HttpAdapter } from "./adapter.js";
export {
  ExperimentalAcpAdapter,
  experimentalAcpAvailability,
} from "./acp.js";
export type {
  ExperimentalAcpAvailability,
  ExperimentalAcpOptions,
  ExperimentalAcpPermissionPolicy,
  ExperimentalAcpPermissionRecord,
  ExperimentalAcpResult,
  ExperimentalAcpRun,
  ExperimentalAcpTarget,
} from "./acp.js";
export { HttpAdapterError } from "./errors.js";
export {
  assertCompatibleCheckpoint,
  checkpointPath,
  HTTP_CHECKPOINT_VERSION,
  readHttpCheckpoint,
  recoverPendingToolOutcome,
  restoreCompletedToolMessages,
  sha256Text,
  stableHash,
  writeHttpCheckpoint,
} from "./checkpoint.js";
export { parseAssistantResponse, parseToolArguments, toolCallSignature } from "./protocol.js";
export {
  httpAdapterNotReadyReason,
  isHttpAdapterReady,
  isLoopbackHttpHost,
  isPrivateOrLocalHost,
} from "./ssrf.js";
export {
  dispatchToolCall,
  isRunCommandAllowed,
  MAX_RUN_COMMAND_BYTES,
  RUN_COMMAND_DENIED_BINS,
  toolsForJob,
  validateToolCallArguments,
} from "./tools.js";
export type { HttpAgentUsage, HttpToolHost } from "./types.js";
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
} from "./mcp-client.js";
export type {
  ExternalMcpTool,
  LegionMcpClientPoolOptions,
  McpFailReason,
  McpLookup,
  ToolCallResult,
} from "./mcp-client.js";
