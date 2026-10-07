/**
 * The SIGKILL harness for C21 A-INT-01 (crash-fidelity control).
 *
 * Bundled by the test with esbuild and run as a CHILD process, because the
 * assertion under test is a durability boundary: the migrator must be killed
 * with signal 9, not shut down gracefully. A graceful close would let any
 * flush-on-exit path run and would make the interruption assertions pass for
 * the wrong reason — the oracle's own control says to treat that as void.
 *
 *   node harness.mjs <projectRoot> <killAfterEvents>
 *
 * With `graceful` as the third argument it exits 0 cleanly instead of dying —
 * the paired control run.
 */
import { migrateToV3 } from "../../src/migrate/v3-forward.js";

const [, , projectRoot, killAfterRaw, mode] = process.argv;
const killAfter = Number(killAfterRaw ?? "5");
const graceful = mode === "graceful";

let fired = false;
await migrateToV3({
  projectRoot: projectRoot as string,
  hooks: {
    afterEvent(n) {
      if (fired || n < killAfter) return;
      fired = true;
      if (graceful) {
        process.exit(0);
      }
      // Uncatchable: no exit handler, no flush, no marker.
      process.kill(process.pid, "SIGKILL");
    },
  },
});
process.exit(0);
