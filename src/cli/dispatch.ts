/**
 * argv classification for the twining-mcp entry point (2.16.1). Before this,
 * the only subcommand dispatch was `argv[2] === "migrate"`; any other word
 * (`twining-mcp drain`, `sync-status`) fell through and booted a full stdio
 * server — a footgun for cron/launchd jobs (field report 2026-09-04).
 */
export const KNOWN_SUBCOMMANDS = ["migrate", "validate-records"] as const;
export type Subcommand = (typeof KNOWN_SUBCOMMANDS)[number];
export type Dispatch =
  | { kind: "server" }
  | { kind: "subcommand"; name: Subcommand; args: string[] }
  | { kind: "unknown"; word: string };

export const CLI_USAGE =
  "usage: twining-mcp [--project <dir>]                      (start the MCP server)\n" +
  "       twining-mcp migrate [--project <dir>] [--dry-run] [--check] [--reverse]\n" +
  "       twining-mcp validate-records [--project <dir>] [--json]\n" +
  "       twining-mcp --version";

export function classifyArgv(argv: string[]): Dispatch {
  const word = argv[2];
  if (word === undefined || word.startsWith("-")) return { kind: "server" };
  if ((KNOWN_SUBCOMMANDS as readonly string[]).includes(word)) {
    return { kind: "subcommand", name: word as Subcommand, args: argv.slice(3) };
  }
  return { kind: "unknown", word };
}
