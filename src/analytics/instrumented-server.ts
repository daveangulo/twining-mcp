/**
 * Instrumented MCP server — patches registerTool to wrap callbacks with timing.
 * Zero changes to any tool file — instrumentation is invisible to them.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MetricsCollector } from "./metrics-collector.js";

/**
 * Patch the server's registerTool method to wrap all tool callbacks with
 * timing instrumentation. Returns the same server instance (mutated).
 */
export function createInstrumentedServer(
  server: McpServer,
  collector: MetricsCollector,
): McpServer {
  const originalRegisterTool = server.registerTool.bind(server);

  // registerTool signature: (name, config, callback)
  server.registerTool = function (
    name: string,
    config: unknown,
    callback: (...cbArgs: unknown[]) => unknown,
  ) {
    const wrappedCallback = async function (...cbArgs: unknown[]) {
      const start = Date.now();
      let success = true;
      let errorCode: string | undefined;

      try {
        const result = await callback(...cbArgs);

        // Detect soft errors by inspecting toolError() response format
        if (result && typeof result === "object" && "content" in (result as Record<string, unknown>)) {
          const content = (result as { content?: unknown[] }).content;
          if (Array.isArray(content) && content.length > 0) {
            const first = content[0] as { text?: string };
            if (first.text) {
              try {
                const parsed = JSON.parse(first.text) as { error?: boolean; code?: string };
                if (parsed.error === true) {
                  success = false;
                  errorCode = parsed.code || "SOFT_ERROR";
                }
              } catch {
                // Not JSON or not error format — that's fine
              }
            }
          }
        }

        const durationMs = Date.now() - start;
        const agentId = extractAgentId(cbArgs);

        // Fire-and-forget metric recording
        collector.record({
          tool_name: name,
          timestamp: new Date().toISOString(),
          duration_ms: durationMs,
          success,
          error_code: errorCode,
          agent_id: agentId,
          ...measureResponse(result),
          ...(extractScope(cbArgs) !== undefined
            ? { scope: extractScope(cbArgs) }
            : {}),
        }).catch(() => {/* never fail a tool call */});

        return result;
      } catch (err) {
        const durationMs = Date.now() - start;
        const agentId = extractAgentId(cbArgs);

        collector.record({
          tool_name: name,
          timestamp: new Date().toISOString(),
          duration_ms: durationMs,
          success: false,
          error_code: err instanceof Error ? err.constructor.name : "UNKNOWN",
          agent_id: agentId,
        }).catch(() => {/* never fail a tool call */});

        throw err;
      }
    };

    return originalRegisterTool(name, config as never, wrappedCallback as never);
  } as typeof server.registerTool;

  return server;
}

/** Extract agent_id from tool call arguments */
/** The call's scope argument, when present and a string. */
function extractScope(cbArgs: unknown[]): string | undefined {
  if (cbArgs.length > 0 && cbArgs[0] && typeof cbArgs[0] === "object") {
    const args = cbArgs[0] as Record<string, unknown>;
    if (typeof args.scope === "string") return args.scope;
  }
  return undefined;
}

/**
 * Cost fields from the serialized response (S4-4): size in bytes, plus a
 * best-effort result count — the length of the first top-level array in the
 * response JSON (entries, results, decisions, warnings, …).
 */
function measureResponse(result: unknown): {
  response_bytes?: number;
  result_count?: number;
} {
  if (!result || typeof result !== "object" || !("content" in result)) {
    return {};
  }
  const content = (result as { content?: unknown[] }).content;
  if (!Array.isArray(content) || content.length === 0) return {};
  const first = content[0] as { text?: string };
  if (typeof first.text !== "string") return {};
  const out: { response_bytes?: number; result_count?: number } = {
    response_bytes: Buffer.byteLength(first.text, "utf-8"),
  };
  try {
    const parsed = JSON.parse(first.text) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const value of Object.values(parsed)) {
        if (Array.isArray(value)) {
          out.result_count = value.length;
          break;
        }
      }
    }
  } catch {
    // Non-JSON responses just get a size.
  }
  return out;
}

function extractAgentId(cbArgs: unknown[]): string {
  // MCP tool callbacks receive (args, extra) where args is the parsed tool input
  if (cbArgs.length > 0 && cbArgs[0] && typeof cbArgs[0] === "object") {
    const args = cbArgs[0] as Record<string, unknown>;
    if (typeof args.agent_id === "string") {
      return args.agent_id;
    }
  }
  return "unknown";
}
