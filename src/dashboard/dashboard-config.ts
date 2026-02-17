/**
 * Dashboard configuration from environment variables.
 * All dashboard config is read from env vars to allow MCP host configuration
 * without modifying .twining/config.yml.
 */

export interface DashboardConfig {
  /** Port number for the HTTP server (default: 24282) */
  port: number;
  /** Whether the dashboard is enabled (default: true, disable with TWINING_DASHBOARD=0) */
  enabled: boolean;
  /** Whether to auto-open browser on start (default: true, disable with TWINING_DASHBOARD_NO_OPEN=1) */
  autoOpen: boolean;
}

/**
 * Read dashboard configuration from environment variables.
 * Defaults: port 24282, enabled true, autoOpen true.
 */
export function getDashboardConfig(): DashboardConfig {
  return {
    port: parseInt(process.env["TWINING_DASHBOARD_PORT"] || "24282", 10),
    enabled: process.env["TWINING_DASHBOARD"] !== "0",
    autoOpen: process.env["TWINING_DASHBOARD_NO_OPEN"] !== "1",
  };
}
