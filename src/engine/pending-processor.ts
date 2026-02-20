/**
 * Processes pending posts and actions from `.twining/` on startup.
 * Reads `pending-posts.jsonl` and `pending-actions.jsonl`, processes each line,
 * then truncates the files. One failure doesn't block others.
 */
import fs from "node:fs";
import path from "node:path";
import type { BlackboardEngine } from "./blackboard.js";
import type { Archiver } from "./archiver.js";

interface PendingPost {
  entry_type: string;
  summary: string;
  detail?: string;
  tags?: string[];
  scope?: string;
  agent_id?: string;
  relates_to?: string[];
}

interface PendingAction {
  action: string;
  [key: string]: unknown;
}

export class PendingProcessor {
  private readonly twiningDir: string;
  private readonly blackboardEngine: BlackboardEngine;
  private readonly archiver: Archiver | null;

  constructor(
    twiningDir: string,
    blackboardEngine: BlackboardEngine,
    archiver: Archiver | null,
  ) {
    this.twiningDir = twiningDir;
    this.blackboardEngine = blackboardEngine;
    this.archiver = archiver;
  }

  /**
   * Process all pending posts and actions on startup.
   * Returns counts of processed items. Never throws — failures are logged.
   */
  async processOnStartup(): Promise<{
    posts_processed: number;
    actions_processed: number;
  }> {
    let posts_processed = 0;
    let actions_processed = 0;

    // Process pending posts
    const postsPath = path.join(this.twiningDir, "pending-posts.jsonl");
    if (fs.existsSync(postsPath)) {
      const content = fs.readFileSync(postsPath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);

      for (const line of lines) {
        try {
          const post = JSON.parse(line) as PendingPost;
          await this.blackboardEngine.post({
            entry_type: post.entry_type as "finding",
            summary: post.summary,
            detail: post.detail ?? "",
            tags: post.tags ?? [],
            scope: post.scope ?? "project",
            agent_id: post.agent_id ?? "pending-processor",
            relates_to: post.relates_to,
          });
          posts_processed++;
        } catch (error) {
          console.error(
            "[twining] Failed to process pending post (skipping):",
            error,
          );
        }
      }

      // Truncate after processing
      fs.writeFileSync(postsPath, "");
    }

    // Process pending actions
    const actionsPath = path.join(this.twiningDir, "pending-actions.jsonl");
    if (fs.existsSync(actionsPath)) {
      const content = fs.readFileSync(actionsPath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);

      for (const line of lines) {
        try {
          const action = JSON.parse(line) as PendingAction;
          if (action.action === "archive" && this.archiver) {
            await this.archiver.archive({
              before: action.before as string | undefined,
            });
          }
          // Other action types can be added here in the future
          actions_processed++;
        } catch (error) {
          console.error(
            "[twining] Failed to process pending action (skipping):",
            error,
          );
        }
      }

      // Truncate after processing
      fs.writeFileSync(actionsPath, "");
    }

    return { posts_processed, actions_processed };
  }
}
