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

        // Single parse shared by the soft-error check and the cost fields
        // (2.16.0 review LS-4): the response is on the hot path, and export-
        // scale payloads made a second full JSON.parse measurable.
        let responseText: string | undefined;
        let parsedResponse: unknown;
        if (result && typeof result === "object" && "content" in (result as Record<string, unknown>)) {
          const content = (result as { content?: unknown[] }).content;
          if (Array.isArray(content) && content.length > 0) {
            const first = content[0] as { text?: string };
            if (typeof first.text === "string") {
              responseText = first.text;
              try {
                parsedResponse = JSON.parse(first.text);
              } catch {
                // Not JSON — size still measurable, count is not.
              }
            }
          }
        }

        // Detect soft errors by inspecting toolError() response format
        if (parsedResponse && typeof parsedResponse === "object") {
          const p = parsedResponse as { error?: boolean; code?: string };
          if (p.error === true) {
            success = false;
            errorCode = p.code || "SOFT_ERROR";
          }
        }

        const durationMs = Date.now() - start;
        const agentId = extractAgentId(cbArgs);
        const scope = extractScope(cbArgs);
        const resultCount = firstArrayLength(parsedResponse);

        // Fire-and-forget metric recording
        collector.record({
          tool_name: name,
          timestamp: new Date().toISOString(),
          duration_ms: durationMs,
          success,
          error_code: errorCode,
          agent_id: agentId,
          ...(responseText !== undefined
            ? { response_bytes: Buffer.byteLength(responseText, "utf-8") }
            : {}),
          ...(resultCount !== undefined ? { result_count: resultCount } : {}),
          ...(scope !== undefined ? { scope } : {}),
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
 * Best-effort result count (S4-4): the length of the first top-level array
 * in the already-parsed response (entries, results, decisions, warnings, …).
 * Best-effort by design — for tools whose first array is not their primary
 * payload (e.g. status's warnings) it counts that array; document, don't
 * trust it per-tool (review LS-5).
 */
function firstArrayLength(parsedResponse: unknown): number | undefined {
  if (
    !parsedResponse ||
    typeof parsedResponse !== "object" ||
    Array.isArray(parsedResponse)
  ) {
    return undefined;
  }
  for (const value of Object.values(parsedResponse as Record<string, unknown>)) {
    if (Array.isArray(value)) return value.length;
  }
  return undefined;
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
