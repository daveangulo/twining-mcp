/**
 * Multiwriter-soak child process (FOUNDATION-PLAN W2.2 acceptance).
 *
 * Plain JS importing the COMPILED stores from dist/ — vitest transforms TS
 * in-memory, so child processes cannot load src/*.ts directly. The parent
 * test skips with a clear message when dist/ is absent; CI always builds
 * before testing.
 *
 * Protocol (stdout, line-oriented):
 *   ACK <writerId>:<seq>   — printed only AFTER the store call returned,
 *                            i.e. the op is durably committed. A killed
 *                            child may have durable ops whose ACK was lost
 *                            in the pipe buffer (allowed); it can never
 *                            ACK an op that didn't commit (the invariant
 *                            the parent audits).
 *   DONE <writerId>        — all ops committed, clean exit.
 *
 * Usage: node child-writer.mjs <backend:files|sqlite> <projectRoot> <writerId> <opsCount>
 */
const [, , backend, projectRoot, writerIdArg, opsArg] = process.argv;
const writerId = Number(writerIdArg);
const OPS = Number(opsArg);
const twiningDir = `${projectRoot}/.twining`;

const distStorage = new URL("../../dist/storage/", import.meta.url).href;

async function makeStores() {
  if (backend === "sqlite") {
    const { openDatabase } = await import(`${distStorage}sqlite/db.js`);
    const {
      SqliteBlackboardStore,
      SqliteDecisionStore,
      SqliteGraphStore,
      SqliteAgentStore,
      SqliteIndexManager,
    } = await import(`${distStorage}sqlite/sqlite-stores.js`);
    const db = openDatabase(twiningDir);
    return {
      bb: new SqliteBlackboardStore(db),
      dc: new SqliteDecisionStore(db),
      gr: new SqliteGraphStore(db),
      ag: new SqliteAgentStore(db),
      im: new SqliteIndexManager(db),
    };
  }
  const { BlackboardStore } = await import(`${distStorage}blackboard-store.js`);
  const { DecisionStore } = await import(`${distStorage}decision-store.js`);
  const { GraphStore } = await import(`${distStorage}graph-store.js`);
  const { AgentStore } = await import(`${distStorage}agent-store.js`);
  const { IndexManager } = await import(
    new URL("../../dist/embeddings/index-manager.js", import.meta.url).href
  );
  return {
    bb: new BlackboardStore(twiningDir),
    dc: new DecisionStore(twiningDir),
    gr: new GraphStore(twiningDir),
    ag: new AgentStore(twiningDir),
    im: new IndexManager(twiningDir),
  };
}

const decisionInput = (summary) => ({
  agent_id: `writer-${writerId}`,
  domain: "soak",
  scope: "src/",
  summary,
  context: "multiwriter soak",
  rationale: "generated",
  alternatives: [],
  confidence: "medium",
  affected_files: [],
  affected_symbols: [],
  reversible: true,
});

const stores = await makeStores();

for (let seq = 0; seq < OPS; seq++) {
  const tag = `w${writerId}:${seq}`;
  switch (seq % 5) {
    case 0:
      await stores.bb.append({
        entry_type: "finding",
        summary: tag,
        detail: "",
        tags: ["soak"],
        scope: "src/",
        agent_id: `writer-${writerId}`,
      });
      break;
    case 1: {
      const d = await stores.dc.create(decisionInput(tag));
      await stores.dc.updateStatus(d.id, "provisional");
      break;
    }
    case 2:
      // Deliberate hot spot: every writer upserts the SAME entity.
      await stores.gr.addEntity({
        name: "shared-entity",
        type: "module",
        properties: { [`w${writerId}_${seq}`]: "1" },
      });
      break;
    case 3:
      // Second hot spot: shared agent row rewrite.
      await stores.ag.touch("shared-agent");
      break;
    case 4:
      await stores.im.addEntry("blackboard", tag, [seq, writerId, 1]);
      break;
  }
  process.stdout.write(`ACK ${tag}\n`);
}

process.stdout.write(`DONE ${writerId}\n`);
