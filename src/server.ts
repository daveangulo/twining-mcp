/**
 * MCP server creation with all tool registrations.
 * Creates stores, engines, and registers all Phase 1 tools.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ensureInitialized } from "./storage/init.js";
import { BlackboardStore } from "./storage/blackboard-store.js";
import { DecisionStore } from "./storage/decision-store.js";
import { BlackboardEngine } from "./engine/blackboard.js";
import { DecisionEngine } from "./engine/decisions.js";
import { registerBlackboardTools } from "./tools/blackboard-tools.js";
import { registerDecisionTools } from "./tools/decision-tools.js";
import { registerLifecycleTools } from "./tools/lifecycle-tools.js";

/**
 * Create and configure the Twining MCP server.
 * Auto-creates .twining/ directory on first use.
 */
export function createServer(projectRoot: string): McpServer {
  // Ensure .twining/ directory exists
  const twiningDir = ensureInitialized(projectRoot);

  // Create stores
  const blackboardStore = new BlackboardStore(twiningDir);
  const decisionStore = new DecisionStore(twiningDir);

  // Create engines
  const blackboardEngine = new BlackboardEngine(blackboardStore);
  const decisionEngine = new DecisionEngine(decisionStore, blackboardEngine);

  // Create MCP server
  const server = new McpServer({
    name: "twining-mcp",
    version: "1.0.0",
  });

  // Register all tools
  registerBlackboardTools(server, blackboardEngine);
  registerDecisionTools(server, decisionEngine);
  registerLifecycleTools(server, twiningDir, blackboardStore, decisionStore);

  return server;
}
