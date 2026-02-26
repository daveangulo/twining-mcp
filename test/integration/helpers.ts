/**
 * Shared test helpers for integration tests.
 * Provides callTool(), parseToolResponse(), and createTestServer().
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "../../src/server.js";

/** Create a temp directory suitable for a Twining test project. */
export function createTmpProjectDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "twining-integration-test-"),
  );
  return dir;
}

/** Create a full Twining MCP server against a temp project root. */
export function createTestServer(tmpDir: string): McpServer {
  return createServer(tmpDir).server;
}

/** Call a registered tool by name, reaching into McpServer internals. */
export async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const registeredTools = (
    server as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (
            args: Record<string, unknown>,
            extra: unknown,
          ) => Promise<unknown>;
        }
      >;
    }
  )._registeredTools;
  const tool = registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not found`);
  const result = await tool.handler(args, {} as unknown);
  return result as { content: Array<{ type: string; text: string }> };
}

/** Parse the JSON response from a tool call. */
export function parseToolResponse(response: {
  content: Array<{ type: string; text: string }>;
}): unknown {
  return JSON.parse(response.content[0]!.text);
}

/** Check if a tool response is an error. */
export function isToolError(response: {
  content: Array<{ type: string; text: string }>;
}): boolean {
  try {
    const parsed = JSON.parse(response.content[0]!.text);
    return parsed.error !== undefined;
  } catch {
    return false;
  }
}
