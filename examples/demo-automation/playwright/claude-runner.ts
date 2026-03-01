/**
 * Child process helpers for spawning the dashboard server and claude -p acts.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

export interface DashboardServer {
  process: ChildProcess;
  port: number;
  url: string;
}

/**
 * Start the Twining MCP server with dashboard enabled.
 * Parses stderr for the dashboard URL to discover the actual port.
 */
export function startDashboardServer(
  distPath: string,
  projectDir: string,
): Promise<DashboardServer> {
  return new Promise((resolve_, reject) => {
    const child = spawn("node", [distPath, "--project", projectDir], {
      env: {
        ...process.env,
        TWINING_DASHBOARD_NO_OPEN: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error("Dashboard server did not start within 10s"));
      }
    }, 10_000);

    child.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString();
      process.stderr.write(`[dashboard] ${line}`);

      // Look for: [twining] Dashboard: http://127.0.0.1:24282
      const match = line.match(
        /\[twining\] Dashboard: (http:\/\/127\.0\.0\.1:(\d+))/,
      );
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve_({
          process: child,
          port: parseInt(match[2], 10),
          url: match[1],
        });
      }
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[dashboard:stdout] ${chunk.toString()}`);
    });

    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    child.on("exit", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`Dashboard process exited with code ${code}`));
      }
    });

    // Close stdin so the server doesn't wait for MCP messages
    child.stdin?.end();
  });
}

/**
 * Spawn `claude -p` with a prompt and return the captured stdout.
 */
export function spawnClaudeAct(
  prompt: string,
  cwd: string,
): Promise<string> {
  return new Promise((resolve_, reject) => {
    const mcpConfig = resolve(cwd, ".mcp.json");

    const child = spawn(
      "claude",
      [
        "-p",
        prompt,
        "--mcp-config",
        mcpConfig,
        "--strict-mcp-config",
        "--allowedTools",
        "mcp__twining__*",
        "--dangerously-skip-permissions",
      ],
      {
        cwd,
        env: {
          ...process.env,
          // Remove CLAUDECODE to prevent nesting detection
          CLAUDECODE: undefined,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    // Close stdin immediately
    child.stdin?.end();

    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[claude] ${chunk.toString()}`);
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve_(stdout);
      } else {
        reject(new Error(`claude -p exited with code ${code}\n${stdout}`));
      }
    });
  });
}
