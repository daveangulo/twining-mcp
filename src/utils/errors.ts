/**
 * Structured error response helpers for MCP tool handlers.
 * All tool handlers return these formats — never throw to the MCP transport.
 */

/** Wrap a successful result in MCP tool response format */
export function toolResult(data: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

/** Wrap an error in MCP tool response format */
export function toolError(message: string, code: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: true, message, code }),
      },
    ],
  };
}

/** Twining-specific error with a machine-readable code */
export class TwiningError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "TwiningError";
    this.code = code;
  }
}
