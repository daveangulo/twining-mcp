/**
 * MCP server creation with all tool registrations.
 * Creates stores, engines, and registers all tools.
 * Phase 2: Wires embedding layer and context assembly.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ensureInitialized } from "./storage/init.js";
import { loadConfig } from "./config.js";
import { BlackboardStore } from "./storage/blackboard-store.js";
import { DecisionStore } from "./storage/decision-store.js";
import { BlackboardEngine } from "./engine/blackboard.js";
import { DecisionEngine } from "./engine/decisions.js";
import { ContextAssembler } from "./engine/context-assembler.js";
import { Embedder } from "./embeddings/embedder.js";
import { IndexManager } from "./embeddings/index-manager.js";
import { SearchEngine } from "./embeddings/search.js";
import { registerBlackboardTools } from "./tools/blackboard-tools.js";
import { registerDecisionTools } from "./tools/decision-tools.js";
import { registerContextTools } from "./tools/context-tools.js";
import { registerLifecycleTools } from "./tools/lifecycle-tools.js";

/**
 * Create and configure the Twining MCP server.
 * Auto-creates .twining/ directory on first use.
 */
export function createServer(projectRoot: string): McpServer {
  // Ensure .twining/ directory exists
  const twiningDir = ensureInitialized(projectRoot);

  // Load config
  const config = loadConfig(twiningDir);

  // Create stores
  const blackboardStore = new BlackboardStore(twiningDir);
  const decisionStore = new DecisionStore(twiningDir);

  // Create embedding layer (lazy-loaded — no ONNX init cost at startup)
  const embedder = new Embedder(twiningDir);
  const indexManager = new IndexManager(twiningDir);
  const searchEngine = new SearchEngine(embedder, indexManager);

  // Create engines (with embedding support)
  const blackboardEngine = new BlackboardEngine(
    blackboardStore,
    embedder,
    indexManager,
    searchEngine,
  );
  const decisionEngine = new DecisionEngine(
    decisionStore,
    blackboardEngine,
    embedder,
    indexManager,
  );
  const contextAssembler = new ContextAssembler(
    blackboardStore,
    decisionStore,
    searchEngine,
    config,
  );

  // Create MCP server
  const server = new McpServer({
    name: "twining-mcp",
    version: "1.0.0",
  });

  // Register all tools
  registerBlackboardTools(server, blackboardEngine);
  registerDecisionTools(server, decisionEngine);
  registerContextTools(server, contextAssembler);
  registerLifecycleTools(server, twiningDir, blackboardStore, decisionStore);

  return server;
}
