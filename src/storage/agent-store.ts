/**
 * Agent registry storage layer.
 * Manages agent records in `.twining/agents/registry.json` as a JSON array.
 * Uses file-store readJSON/writeJSON for locked file I/O.
 * Upsert semantics by agent_id with capability merging.
 */
import path from "node:path";
import { readJSON, writeJSON, ensureDir } from "./file-store.js";
import { normalizeTags } from "../utils/tags.js";
import type { AgentRecord } from "../utils/types.js";

export class AgentStore {
  private readonly registryPath: string;
  private readonly agentsDir: string;

  constructor(twiningDir: string) {
    this.agentsDir = path.join(twiningDir, "agents");
    this.registryPath = path.join(this.agentsDir, "registry.json");
  }

  /** Read the registry, returning empty array if file doesn't exist. */
  private async readRegistry(): Promise<AgentRecord[]> {
    try {
      return await readJSON<AgentRecord[]>(this.registryPath);
    } catch {
      // File doesn't exist or is corrupt — treat as empty
      return [];
    }
  }

  /** Write the registry, ensuring agents/ directory exists. */
  private async writeRegistry(agents: AgentRecord[]): Promise<void> {
    ensureDir(this.agentsDir);
    await writeJSON(this.registryPath, agents);
  }

  /**
   * Create or update an agent record.
   * - If agent_id exists: merge capabilities (union), overwrite role/description if provided
   * - If agent_id doesn't exist: create new record
   */
  async upsert(input: {
    agent_id: string;
    capabilities?: string[];
    role?: string;
    description?: string;
  }): Promise<AgentRecord> {
    const agents = await this.readRegistry();
    const now = new Date().toISOString();
    const normalizedCaps = normalizeTags(input.capabilities ?? []);

    const existingIdx = agents.findIndex((a) => a.agent_id === input.agent_id);

    if (existingIdx >= 0) {
      const existing = agents[existingIdx]!;
      // Merge capabilities: union of existing + new, then normalize
      const mergedCaps = normalizeTags([
        ...existing.capabilities,
        ...normalizedCaps,
      ]);
      existing.capabilities = mergedCaps;
      // Overwrite role/description only if explicitly provided (not undefined)
      if (input.role !== undefined) {
        existing.role = input.role;
      }
      if (input.description !== undefined) {
        existing.description = input.description;
      }
      existing.last_active = now;
      await this.writeRegistry(agents);
      return existing;
    }

    // Create new record
    const agent: AgentRecord = {
      agent_id: input.agent_id,
      capabilities: normalizedCaps,
      role: input.role,
      description: input.description,
      registered_at: now,
      last_active: now,
    };
    agents.push(agent);
    await this.writeRegistry(agents);
    return agent;
  }

  /**
   * Update last_active timestamp, creating a minimal record if agent doesn't exist.
   * This is the auto-register path (REG-01).
   */
  async touch(agentId: string): Promise<AgentRecord> {
    const agents = await this.readRegistry();
    const now = new Date().toISOString();

    const existing = agents.find((a) => a.agent_id === agentId);

    if (existing) {
      existing.last_active = now;
      await this.writeRegistry(agents);
      return existing;
    }

    // Create minimal record
    const agent: AgentRecord = {
      agent_id: agentId,
      capabilities: [],
      registered_at: now,
      last_active: now,
    };
    agents.push(agent);
    await this.writeRegistry(agents);
    return agent;
  }

  /** Get a single agent by agent_id, or null if not found. */
  async get(agentId: string): Promise<AgentRecord | null> {
    const agents = await this.readRegistry();
    return agents.find((a) => a.agent_id === agentId) ?? null;
  }

  /** Get all agents from registry. */
  async getAll(): Promise<AgentRecord[]> {
    return this.readRegistry();
  }

  /**
   * Find agents with any matching capability tag (OR match).
   * Input tags are normalized before matching.
   */
  async findByCapabilities(tags: string[]): Promise<AgentRecord[]> {
    const normalizedInput = normalizeTags(tags);
    if (normalizedInput.length === 0) return [];

    const agents = await this.readRegistry();
    return agents.filter((agent) =>
      agent.capabilities.some((cap) => normalizedInput.includes(cap)),
    );
  }
}
