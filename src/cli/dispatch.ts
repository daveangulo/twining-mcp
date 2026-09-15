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

/**
 * argv classification for the `twining` CLI (2.17.0).
 *
 * Deliberately separate from classifyArgv above: that one answers "server or
 * subcommand?" for the twining-mcp entry point, where a bare word is a
 * footgun. Here a bare word is the normal case — it names a command — and the
 * only reserved words are the two pre-existing subcommands plus capabilities.
 */
export type CliDispatch =
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "capabilities"; args: string[] }
  | { kind: "subcommand"; name: Subcommand; args: string[] }
  | { kind: "command"; name: string; args: string[] }
  | { kind: "usage"; reason: string };

export const TWINING_CLI_USAGE = [
  "usage: twining <command> [--json '<json>' | --input-file <f> | --stdin]",
  "                        [--project <dir>] [--agent-id <id>]",
  "       twining capabilities [--project <dir>]",
  "       twining migrate [--project <dir>] [--dry-run] [--check] [--reverse]",
  "       twining validate-records [--project <dir>] [--json]",
  "       twining --version | --help",
  "",
  "Commands are the twining_* tool names (the twining_ prefix may be omitted).",
  "Run `twining capabilities` for the full list with JSON Schemas.",
  "Every command prints ONE JSON envelope on stdout; diagnostics go to stderr.",
  "Exit codes: 0 ok, 1 command error, 2 usage / unknown command / bad input.",
].join("\n");

export function classifyCliArgv(argv: string[]): CliDispatch {
  const word = argv[2];
  if (word === undefined) return { kind: "usage", reason: "no command given" };
  if (word === "--version" || word === "-v") return { kind: "version" };
  if (word === "--help" || word === "-h") return { kind: "help" };
  if (word.startsWith("-")) {
    return { kind: "usage", reason: `expected a command, got the flag "${word}"` };
  }
  const args = argv.slice(3);
  if (word === "capabilities") return { kind: "capabilities", args };
  if ((KNOWN_SUBCOMMANDS as readonly string[]).includes(word)) {
    return { kind: "subcommand", name: word as Subcommand, args };
  }
  return { kind: "command", name: word, args };
}
