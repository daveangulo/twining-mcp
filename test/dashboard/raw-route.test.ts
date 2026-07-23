/**
 * Security + behavior tests for the read-only raw-file route (TRIAGE-SPEC §8)
 * and the repo-info helpers. resolveRawPath is the jail — every deny reason
 * maps to 404 at the route.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { handleRequest } from "../../src/dashboard/http-server.js";
import { resolveRawPath } from "../../src/dashboard/raw-path.js";
import { remoteToWebUrl } from "../../src/dashboard/repo-info.js";

function httpGet(
  port: number,
  urlPath: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: "127.0.0.1", port, path: urlPath }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      })
      .on("error", reject);
  });
}

describe("resolveRawPath — the jail", () => {
  let root: string;
  let outside: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "twining-raw-"));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "twining-raw-outside-"));
    fs.mkdirSync(path.join(root, "docs"));
    fs.mkdirSync(path.join(root, ".twining"));
    fs.writeFileSync(path.join(root, "docs", "spec.md"), "# spec\n");
    fs.writeFileSync(path.join(root, ".twining", "config.yml"), "secret: yes\n");
    fs.writeFileSync(path.join(outside, "loot.txt"), "outside\n");
    fs.symlinkSync(path.join(outside, "loot.txt"), path.join(root, "docs", "escape.md"));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("resolves a plain repo-relative file", () => {
    const real = resolveRawPath(root, "docs/spec.md");
    expect(real).not.toBeNull();
    expect(fs.readFileSync(real as string, "utf8")).toBe("# spec\n");
  });

  it("denies traversal, absolute paths, and malformed input", () => {
    expect(resolveRawPath(root, "../etc/passwd")).toBeNull();
    expect(resolveRawPath(root, "docs/../../etc/passwd")).toBeNull();
    expect(resolveRawPath(root, "/etc/passwd")).toBeNull();
    expect(resolveRawPath(root, "docs\\spec.md")).toBeNull();
    expect(resolveRawPath(root, "")).toBeNull();
    expect(resolveRawPath(root, "docs//spec.md")).toBeNull();
  });

  it("denies dotted segments — .twining, .git, dotfiles", () => {
    expect(resolveRawPath(root, ".twining/config.yml")).toBeNull();
    expect(resolveRawPath(root, ".git/config")).toBeNull();
    expect(resolveRawPath(root, "docs/.hidden")).toBeNull();
  });

  it("denies symlink escapes, directories, and missing files", () => {
    expect(resolveRawPath(root, "docs/escape.md")).toBeNull();
    expect(resolveRawPath(root, "docs")).toBeNull();
    expect(resolveRawPath(root, "docs/missing.md")).toBeNull();
  });
});

describe("GET /api/raw", () => {
  let root: string;
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "twining-raw-route-"));
    fs.mkdirSync(path.join(root, ".twining"), { recursive: true });
    fs.mkdirSync(path.join(root, "docs"));
    fs.writeFileSync(path.join(root, "docs", "spec.md"), "# hello <script>alert(1)</script>\n");
    const publicDir = path.resolve("src/dashboard/public");
    server = http.createServer(handleRequest(publicDir, root));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    port = typeof addr === "object" && addr !== null ? addr.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("serves file content as text/plain with nosniff — never executable HTML", async () => {
    const res = await httpGet(port, `/api/raw?path=${encodeURIComponent("docs/spec.md")}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.body).toContain("# hello");
  });

  it("returns 404 for denied and missing paths without distinguishing why", async () => {
    for (const p of ["../etc/passwd", ".twining/config.yml", "docs/missing.md", ""]) {
      const res = await httpGet(port, `/api/raw?path=${encodeURIComponent(p)}`);
      expect(res.status, `path: ${p}`).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: "Not found" });
    }
  });

  it("serves /api/repo-info with web_url and branch keys", async () => {
    const res = await httpGet(port, "/api/repo-info");
    expect(res.status).toBe(200);
    const info = JSON.parse(res.body);
    expect("web_url" in info).toBe(true);
    expect("branch" in info).toBe(true);
  });
});

describe("remoteToWebUrl", () => {
  it("normalizes ssh and https remotes to browsable https", () => {
    expect(remoteToWebUrl("git@github.com:daveangulo/twining-mcp.git")).toBe(
      "https://github.com/daveangulo/twining-mcp",
    );
    expect(remoteToWebUrl("https://github.com/daveangulo/twining-mcp.git")).toBe(
      "https://github.com/daveangulo/twining-mcp",
    );
    expect(remoteToWebUrl("https://github.com/daveangulo/twining-mcp")).toBe(
      "https://github.com/daveangulo/twining-mcp",
    );
  });

  it("returns null for null or unrecognized remotes", () => {
    expect(remoteToWebUrl(null)).toBeNull();
    expect(remoteToWebUrl("ssh://weird//")).toBeNull();
  });
});
