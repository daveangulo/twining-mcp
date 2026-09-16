/**
 * The 2.x SessionStart context, verbatim.
 *
 * This text is emitted ONLY when the store is not v3-enabled. On a 2.x store
 * the gates ARE the capture mechanism — the model calling `twining_assemble`
 * and `twining_record` is the only thing that records anything — so removing
 * the prose there would remove the feature.
 *
 * On a v3 store the adapter captures at the hook boundary and this text is
 * never emitted, which is not a style preference: C15's A2-NO-PROSE asserts
 * that no payload delivered to a model contains a reminder substring
 * (including "Gate 1"/"Gate 2"), and its PROSE-REMINDER FALLBACK control
 * exists precisely to catch an implementation that claims hook-driven capture
 * while still relying on nagging. Keeping the two texts in one file, with this
 * comment, is how the distinction stays visible to whoever edits it next.
 *
 * Kept byte-identical to plugin/hooks/session-start-context.sh's heredoc; a
 * test asserts the two agree.
 */
export const LEGACY_SESSION_START_CONTEXT =
  "## Coordination — Twining Lifecycle Gates\n\n" +
  "Twining MCP tools are available. Two BLOCKING gates for tasks involving code exploration, modification, or architectural decisions:\n\n" +
  "Gate 1 — Context Assembly (BEFORE any work): call `twining_assemble` with the task description and the narrowest scope (e.g. `src/auth/`, not `project`) before reading code or making changes; call `twining_why` on files you intend to modify.\n\n" +
  'Gate 2 — Record (BEFORE committing or ending): call `twining_record` before every git commit and before ending the session — hooks enforce this. Include what you did (summary) and choices you made (decisions, as natural sentences: "Chose X over Y — reason"). Record findings, warnings, and surprises as you go via `twining_post` — they are what make the blackboard useful to the next session.\n\n' +
  "Run `twining_housekeeping({})` at the start of long sessions (preview is safe).";
