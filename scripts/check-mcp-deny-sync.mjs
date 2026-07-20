// Fails when .claude/settings.json's twining deniedMcpServers entry no longer
// matches plugin/.mcp.json's bundled server command. The deny matches by exact
// command array (name-based matching can't work — both servers are named
// "twining"), so a plugin pin bump without the matching settings update
// silently re-launches dual twining servers in this repo.
import { readFileSync } from 'node:fs';

const plugin = JSON.parse(readFileSync('plugin/.mcp.json', 'utf8')).mcpServers.twining;
const expected = JSON.stringify([plugin.command, ...plugin.args]);
const denies = (JSON.parse(readFileSync('.claude/settings.json', 'utf8')).deniedMcpServers ?? [])
  .map((d) => JSON.stringify(d.serverCommand));

if (!denies.includes(expected)) {
  console.error(
    `deniedMcpServers in .claude/settings.json is out of sync with plugin/.mcp.json.\n` +
    `Expected a serverCommand entry: ${expected}\n` +
    `Found: ${denies.join('\n       ') || '(none)'}\n` +
    `Update the deny to match the plugin's bundled server command, or dual twining servers will launch.`
  );
  process.exit(1);
}
console.log('twining deny in sync with plugin server command');
