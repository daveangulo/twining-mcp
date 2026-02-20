# Twining MCP: Multi-Project Federation Design

**Status:** Draft
**Version:** 0.1
**Target Release:** v1.4+

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Federation Model](#federation-model)
3. [Query Federation](#query-federation)
4. [Decision Propagation](#decision-propagation)
5. [Consistency Model](#consistency-model)
6. [Federation Digest Format](#federation-digest-format)
7. [Configuration](#configuration)
8. [Implementation Options](#implementation-options)
9. [Recommended Path](#recommended-path)
10. [Non-Goals](#non-goals)
11. [Open Questions](#open-questions)

---

## Problem Statement

Twining MCP currently operates within a single project scope. One `.twining/` directory tracks decisions, blackboard entries, and knowledge graph entities for one codebase. This is sufficient for isolated projects but breaks down in several increasingly common scenarios.

### Multi-repo architectures

Modern systems are frequently decomposed across multiple repositories: a frontend app, a backend API, a shared SDK, infrastructure-as-code, and so on. An architectural decision made in the API repo (e.g., changing an authentication scheme, renaming an endpoint, or altering a response format) directly affects the frontend and SDK repos. Today, there is no mechanism for an agent working in the frontend repo to discover that the API team decided to deprecate v2 endpoints last week.

### Shared libraries

A shared library used by five downstream projects may undergo a breaking change. The decision rationale lives in the library's `.twining/` directory, invisible to consumers. Downstream agents re-discover constraints the hard way, or worse, make contradictory assumptions about library behavior.

### Monorepo subdirectories

In monorepos, teams often want independent Twining instances per package or service (e.g., `packages/auth/`, `packages/billing/`, `services/api/`) to keep decision scopes manageable. But cross-cutting decisions (shared database schema changes, API versioning policy, deployment strategy) need visibility across subdirectories.

### Team coordination

Teams working on related but separate projects need to see each other's architectural decisions. A platform team's decision to migrate from PostgreSQL to CockroachDB affects every service team. Without federation, this decision exists only in the platform team's Twining instance, and other teams learn about it through Slack messages, meetings, or breakage.

---

## Federation Model

Twining federation uses a **hub-and-spoke architecture** where a central federation index aggregates decision summaries from multiple child instances.

```
                    +------------------------+
                    |   Federation Index     |
                    |   (.twining/)          |
                    |                        |
                    |  Aggregated decision   |
                    |  digests from all      |
                    |  child projects        |
                    +----------+-------------+
                               |
              +----------------+----------------+
              |                |                |
     +--------v-----+  +------v-------+  +-----v--------+
     | Project A    |  | Project B    |  | Project C    |
     | (.twining/)  |  | (.twining/)  |  | (.twining/)  |
     |              |  |              |  |              |
     | Authoritative|  | Authoritative|  | Authoritative|
     | for its own  |  | for its own  |  | for its own  |
     | decisions    |  | decisions    |  | decisions    |
     +--------------+  +--------------+  +--------------+
```

### Key properties

**Child autonomy.** Each child instance remains fully autonomous and authoritative for its own state. Federation never modifies a child's local decisions, blackboard, or knowledge graph. A child instance functions identically whether federation is enabled or not.

**Lightweight aggregation.** Children push **decision digests** to the federation index -- not full decision records. A digest contains the decision's id, summary, scope, domain, timestamp, confidence, and status. This keeps the federation index small and fast to query.

**Read-optimized index.** The federation index is a read-optimized aggregation layer. It does not make decisions itself. It does not resolve conflicts. It surfaces cross-project decisions to agents that ask for them.

**Opt-in participation.** Federation is disabled by default. Projects opt in by setting `federation.enabled: true` in their `.twining/config.json` and configuring a parent path or endpoint.

---

## Query Federation

Cross-project queries extend the existing `twining_assemble` tool with an optional `federated` parameter.

### Query flow

1. **Local assembly first.** `twining_assemble` executes against the local `.twining/` state exactly as it does today. Local decisions, warnings, needs, questions, and graph entities are scored and ranked.

2. **Budget accounting.** After local results are assembled, the remaining token budget is calculated. If `federated: true` and there is remaining budget, the query proceeds to the federation index.

3. **Federated query.** The federation index is queried for decisions matching the scope prefix. For example, if the local scope is `src/auth/`, the federation index is searched for decisions from other projects whose scope overlaps with authentication concerns. Scope matching at the federation level uses both prefix matching and keyword relevance.

4. **Result merging.** Federated results fill the remaining token budget. Each federated result is tagged with its `source_project` name so agents can distinguish local from cross-project decisions.

5. **Response format.** The assembled context includes a new `federated_decisions` section, clearly separated from local results:

```json
{
  "local": {
    "decisions": [...],
    "warnings": [...],
    "needs": [...]
  },
  "federated": {
    "decisions": [
      {
        "id": "01JABCDEF...",
        "summary": "Migrate auth to OAuth2 PKCE flow",
        "scope": "src/auth/",
        "domain": "architecture",
        "source_project": "api-gateway",
        "timestamp": "2026-02-15T10:30:00Z",
        "confidence": "high",
        "status": "active"
      }
    ]
  }
}
```

### Prioritization rules

- Local results always take priority over federated results.
- Within federated results, decisions are ranked by: (a) scope relevance, (b) recency, (c) confidence level.
- Federated decisions with `status: "overridden"` or `status: "superseded"` are excluded by default.
- The token budget is a hard limit. If local results exhaust the budget, no federated results are included.

### On-demand detail fetching

Federated results are digests, not full decision records. When an agent needs the full rationale, alternatives, and affected files for a federated decision, it can request the full record via:

- **File-based federation:** Read the decision JSON directly from the child project's `.twining/decisions/` directory (requires filesystem access).
- **HTTP federation:** Fetch the full decision via `GET /decisions/{id}` from the child project's Twining API.

This lazy-loading approach keeps federation queries fast while still enabling deep inspection when needed.

---

## Decision Propagation

Decisions flow in two directions, with different semantics for each.

### Downstream: child to parent (push)

When a child instance records a decision via `twining_decide`, the decision digest is pushed to the federation index. This happens:

- **Synchronously** if `push_on_decide: true` in config (default for file-based federation).
- **Asynchronously** via webhook if using HTTP federation.
- **On schedule** via a periodic sync job as a fallback.

The push operation is **fire-and-forget** from the child's perspective. If the push fails (parent unreachable, filesystem locked), the child records the decision locally and retries on the next push opportunity. No decision is ever blocked or delayed by federation.

The digest written to the parent's federation directory follows the format defined in [Federation Digest Format](#federation-digest-format).

### Upstream: parent to child (advisory)

Cross-project decisions that may affect a child are surfaced as **findings** on the child's blackboard. This is advisory only -- the child's agents see the finding but are not required to act on it.

Example: If the `api-gateway` project decides to deprecate v2 endpoints, and the `frontend` project has federation enabled, the next time `twining_assemble` runs in `frontend` with a relevant scope, the deprecation decision appears in the federated results section.

Upstream propagation does **not** modify the child's decision store. It does **not** create local decisions. It does **not** auto-populate the child's knowledge graph. The federated decision is presented as external context, clearly labeled with its source project.

### Digest lifecycle

Decision digests in the federation index track the lifecycle of their source decisions:

- When a child decision is **overridden**, the digest's status is updated to `"overridden"`.
- When a child decision is **reconsidered**, the digest's status is updated to `"provisional"`.
- When a child decision is **superseded**, the old digest is marked `"superseded"` and the new digest is added.

This means the federation index always reflects the current state of child decisions, not just their creation.

---

## Consistency Model

Twining federation is **eventually consistent** by design.

### Authoritative sources

Each child instance is the single source of truth for its own decisions. The federation index is a derived, read-optimized view. If there is a discrepancy between a child's decision store and the federation index, the child is correct.

### Lag tolerance

The federation index may lag behind child instances. In file-based federation, the lag is the time between a `twining_decide` call and the next filesystem sync. In HTTP federation, the lag is the webhook delivery latency. In either case, the lag is expected to be seconds to minutes, not hours.

Agents querying federated data should treat results as **best-effort current**. A federated decision that appears active may have been overridden moments ago. This is acceptable because:

- Federation is advisory, not authoritative.
- Agents working in a child project always have the authoritative local state.
- Cross-project decisions inform but do not constrain local work.

### Conflict handling

When decisions in different projects contradict each other, the federation index flags the conflict as a **warning** on both projects' blackboards. It does not attempt to resolve the conflict. Resolution requires human judgment or a coordinating agent operating at the federation level.

Example conflict detection heuristics:
- Two projects make decisions in the same domain with overlapping scopes and different conclusions.
- A child decision depends on an assumption that another child's decision invalidates.
- Two projects declare incompatible constraints on a shared dependency.

Conflict detection is best-effort and may produce false positives. It is a notification mechanism, not an enforcement mechanism.

### No distributed locking

There are no locks, no consensus protocols, no two-phase commits. Each instance operates independently. The federation index is append-mostly (digests are added or status-updated, rarely deleted). This simplicity is intentional: Twining federation optimizes for developer experience and low operational overhead, not for strong consistency guarantees that would add complexity without proportional benefit.

---

## Federation Digest Format

The digest is the unit of data exchanged between child instances and the federation index.

### TypeScript interface

```typescript
interface FederationDigest {
  source_project: string;
  decisions: Array<{
    id: string;
    summary: string;
    scope: string;
    domain: string;
    timestamp: string;
    confidence: string;
    status: string;
  }>;
  generated_at: string;
}
```

### Field semantics

| Field | Description |
|-------|-------------|
| `source_project` | The `project_name` from the child's federation config. Must be unique across the federation. |
| `decisions` | Array of decision digests, each containing the minimal fields needed for cross-project discovery. |
| `decisions[].id` | The ULID of the decision in the child instance. Globally unique. |
| `decisions[].summary` | One-line decision summary (max 200 chars, matching the existing `twining_decide` constraint). |
| `decisions[].scope` | The scope within the child project (e.g., `src/auth/`). Prefixed with `source_project:` in federation queries for disambiguation. |
| `decisions[].domain` | The decision domain (e.g., `architecture`, `api-design`). |
| `decisions[].timestamp` | ISO 8601 timestamp of when the decision was made. |
| `decisions[].confidence` | Confidence level: `high`, `medium`, or `low`. |
| `decisions[].status` | Current status: `active`, `provisional`, `superseded`, or `overridden`. |
| `generated_at` | ISO 8601 timestamp of when this digest was generated. Used for staleness detection. |

### File format

When using file-based federation, each child project writes its digest to:

```
<federation_index>/.twining/federation/<project_name>.json
```

The federation index reads all files in `.twining/federation/` to build its aggregated view.

### Digest size

A typical decision digest is ~200 bytes JSON. A project with 100 decisions produces a ~20KB digest file. A federation of 50 projects with 100 decisions each produces ~1MB of aggregated digest data. This is well within the limits of filesystem-based storage and in-memory querying.

---

## Configuration

Federation is configured in each project's `.twining/config.json`.

### Child configuration

```json
{
  "federation": {
    "enabled": false,
    "role": "child",
    "parent_path": "../federation-index/.twining",
    "push_on_decide": true,
    "project_name": "my-project"
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Whether federation is active for this instance. |
| `role` | string | `"child"` | Either `"child"` (pushes digests to parent) or `"parent"` (aggregates digests from children). |
| `parent_path` | string | `null` | Filesystem path to the parent federation index's `.twining/` directory. Required for file-based federation. |
| `parent_url` | string | `null` | HTTP endpoint for the parent federation index. Used for HTTP-based federation. Mutually exclusive with `parent_path`. |
| `push_on_decide` | boolean | `true` | Whether to push a digest update immediately when `twining_decide` is called. If false, digests are pushed on a schedule or manually. |
| `project_name` | string | Required | Unique identifier for this project within the federation. Used as the `source_project` in digests. |

### Parent (federation index) configuration

```json
{
  "federation": {
    "enabled": true,
    "role": "parent",
    "children": [
      {
        "project_name": "api-gateway",
        "path": "../api-gateway/.twining"
      },
      {
        "project_name": "frontend",
        "path": "../frontend/.twining"
      },
      {
        "project_name": "shared-sdk",
        "path": "../shared-sdk/.twining"
      }
    ],
    "conflict_detection": true,
    "stale_threshold_hours": 24
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `children` | array | `[]` | List of child projects to aggregate. Each entry specifies a project name and either a `path` or `url`. |
| `conflict_detection` | boolean | `true` | Whether to run conflict detection heuristics across child digests. |
| `stale_threshold_hours` | number | `24` | Digests older than this threshold trigger a staleness warning. |

### Monorepo shorthand

For monorepos where all projects share a filesystem, a simplified configuration uses path discovery:

```json
{
  "federation": {
    "enabled": true,
    "role": "parent",
    "discover_children": "packages/*/.twining",
    "conflict_detection": true
  }
}
```

The `discover_children` glob pattern automatically finds child instances without enumerating them explicitly.

---

## Implementation Options

Four approaches for implementing federation, analyzed by complexity, flexibility, and operational requirements.

### (a) Git submodule sharing `.twining/` directories

The federation index is a git repository that includes each child's `.twining/` directory as a git submodule (or subtree). Digest files are committed and synced via standard git operations.

**Pros:**
- Zero infrastructure beyond git, which teams already use.
- Full version history of all federation state via git log.
- Works naturally in monorepos where all projects share a single git repository.
- Offline-capable: agents can query federation state from their local git clone.
- Atomic updates via git commits.

**Cons:**
- Git submodules are notoriously awkward to manage (stale refs, detached heads, forgotten updates).
- Push latency is limited by git commit/push cycles, not suitable for real-time sync.
- Requires all projects to be on the same git hosting platform.
- Merge conflicts in digest files are possible if two projects push simultaneously.
- Does not scale well beyond ~20 projects due to submodule management overhead.

### (b) File-based sync (rsync/watch)

Each child's digest file is synced to the federation index directory via rsync, fswatch, or a similar file-synchronization mechanism.

**Pros:**
- Simple conceptually: each child writes a file, the parent reads files.
- Works across repos without git coupling.
- Low latency: file watchers can trigger near-instant sync.
- Compatible with existing CI/CD pipelines (sync as a post-commit hook or CI step).

**Cons:**
- Requires infrastructure: either a shared filesystem, an rsync daemon, or a CI job.
- File watchers add operational complexity (crash recovery, duplicate detection).
- No built-in version history; need external tooling for audit trail.
- Partial writes can produce corrupted digest files without atomic write guarantees.
- Security considerations for cross-project filesystem access.

### (c) HTTP API between Twining instances

Each Twining instance exposes an HTTP API. Children POST digests to the parent. The parent serves federated queries. This extends the existing dashboard HTTP server.

**Pros:**
- Most flexible: works across any network topology (local, VPN, internet).
- Natural fit for the existing Twining dashboard HTTP server.
- Supports authentication, rate limiting, and access control.
- Async push via webhooks decouples child and parent lifecycles.
- Scales to large federations (hundreds of projects).

**Cons:**
- Requires running Twining instances as long-lived services, not just CLI tools.
- Network dependencies: federation queries fail if the parent is unreachable.
- Authentication and security must be implemented (API keys, TLS).
- Higher implementation complexity than file-based approaches.
- Operational overhead: monitoring, deployment, availability.

### (d) Shared filesystem with namespace prefixes

All projects write to a single shared `.twining/` directory, using namespace prefixes to separate their data (e.g., `decisions/api-gateway/`, `decisions/frontend/`).

**Pros:**
- Simplest possible implementation: just change the file paths.
- No sync mechanism needed; all projects read/write the same directory.
- Trivially consistent: there is only one copy of the data.
- Works well in monorepos or teams sharing an NFS mount.

**Cons:**
- Requires shared filesystem access, which is not always available.
- No isolation: a buggy instance can corrupt another project's data.
- File locking issues with concurrent writes from multiple instances.
- Tightly couples project lifecycles (cannot move a project without reconfiguring federation).
- Naming collisions if `project_name` values are not carefully managed.

---

## Recommended Path

The recommendation is a phased approach that starts simple and evolves toward the most scalable solution.

### Phase 1: Git submodule federation (v1.4)

**Target:** Monorepos and small multi-repo setups (2-10 projects).

Implement file-based digest generation in the `twining_decide` handler. When `push_on_decide` is true and `parent_path` is set, write the project's digest to `<parent_path>/federation/<project_name>.json` after each decision.

Extend `twining_assemble` to read digest files from the federation directory when `federated: true` is requested.

This approach requires no new infrastructure, no running services, and no network dependencies. It works today for any team that can share filesystem paths between projects.

**Deliverables:**
- `FederationDigest` type definition in `src/utils/types.ts`
- Digest generation in `src/engine/decisions.ts`
- Digest writing in `src/storage/decision-store.ts`
- Federation reading in `src/engine/context-assembler.ts`
- Config schema extension in `src/utils/types.ts`
- Tests for digest generation, writing, reading, and assembly

### Phase 2: HTTP API federation (v1.5+)

**Target:** Multi-repo setups, distributed teams, large federations.

Extend the existing dashboard HTTP server with federation endpoints:

- `POST /federation/digest` -- child pushes its digest to the parent.
- `GET /federation/decisions` -- query federated decisions with scope/domain filters.
- `GET /federation/decisions/:id` -- fetch full decision details from the authoritative child.

The HTTP API uses the same `FederationDigest` format as file-based federation, ensuring backward compatibility. Projects can migrate from file-based to HTTP federation by changing config, not code.

**Deliverables:**
- HTTP endpoints in `src/dashboard/` or new `src/federation/` module
- Authentication middleware (API key-based, simple and auditable)
- Webhook support for async push
- Client library for cross-instance queries
- Integration tests with multiple Twining instances

### Design principle: same digest, different transport

Both phases use the same `FederationDigest` format. The only difference is the transport layer (filesystem vs. HTTP). This means:

- Digest generation logic is written once and shared.
- The federation index reads digests from a uniform interface regardless of how they arrived.
- Projects can mix transports within a single federation (some file-based, some HTTP).

---

## Non-Goals

The following are explicitly out of scope for the federation design. This section exists to prevent scope creep and to set clear expectations.

### Real-time sync between instances

Federation is eventually consistent with seconds-to-minutes lag. Use cases requiring sub-second consistency (e.g., distributed transactions across projects) are not supported and are not a target.

### Distributed consensus protocols

No Raft, no Paxos, no CRDTs. Each instance is authoritative for its own state. The federation index is a derived view, not a replicated state machine. This dramatically simplifies implementation and operations.

### Cross-project constraint enforcement

Federation surfaces decisions and flags potential conflicts, but it does not enforce constraints across projects. If Project A decides "all APIs must use JSON" and Project B decides "our API uses protobuf," federation will flag the conflict but will not prevent Project B's decision.

### Automatic conflict resolution

When conflicts are detected, federation posts warnings. Humans or coordinating agents decide how to resolve them. Automatic resolution would require understanding project priorities, team dynamics, and business context that federation cannot infer.

### Federation of blackboard entries

Only decisions are federated. Blackboard entries (findings, warnings, questions, status updates) remain local to each project. Rationale:

- Blackboard entries are high-volume and often ephemeral.
- Cross-project relevance of blackboard entries is low (most are contextual to the current work session).
- Decisions are the stable, high-value artifacts that benefit most from cross-project visibility.
- Federating blackboard entries would significantly increase sync volume and noise.

### Federation of knowledge graph state

The knowledge graph is local to each project. Cross-project entity relationships (e.g., "Project A's AuthService calls Project B's TokenAPI") are valuable but require a more sophisticated graph federation model that is deferred to a future design.

---

## Open Questions

1. **Scope disambiguation.** When Project A has `src/auth/` and Project B has `src/auth/`, how should federated queries disambiguate? Current thinking: prefix with project name (e.g., `api-gateway:src/auth/`), but this changes scope semantics.

2. **Digest pruning.** Should the federation index prune digests for superseded/overridden decisions, or keep them for historical context? Keeping all digests is simpler but grows unboundedly.

3. **Access control.** In HTTP federation, should children be able to restrict which decisions are federated? Some decisions may be sensitive (security-related, pre-announcement features). A `federate: false` flag on `twining_decide` could support this.

4. **Bootstrapping.** When a project joins a federation, should it push all existing decisions or only future decisions? Pushing history provides full context but may be large. A `--since` flag on initial push could give teams control.

5. **Federation of `twining_why`.** Should `twining_why` on a file also show federated decisions that affect that file from other projects? This would require scope mapping between projects, which may not be straightforward.
