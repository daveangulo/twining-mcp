/**
 * Entity scope repair — one-time backfill for graph entities whose `scope`
 * property was overwritten by the pre-fix last-writer-wins upsert.
 *
 * The graph auto-populator stamps every file and symbol entity with the scope
 * of the decision that touched it. Before utils/entity-properties.ts made
 * `scope` a union, a later decision in a different scope silently replaced the
 * earlier value — so an entity ended up asserting a single scope that was
 * merely the most recent one, and often contradicted its own path. Measured on
 * the dogfood repo: 110 of 242 scoped file entities carried a scope their own
 * name did not start with.
 *
 * The lost information is recoverable because the auto-populator also writes a
 * `decided_by` relation from each file/symbol entity to the decision entity
 * that touched it, and the decision entity carries that decision's scope in its
 * own properties. Unioning those gives back the full set.
 *
 * Repair is opt-in and dry-run by default, matching the rest of housekeeping.
 */
import type { IGraphStore } from "../storage/interfaces.js";
import {
  joinSetProperty,
  splitSetProperty,
} from "../utils/entity-properties.js";

export interface EntityScopeRepairItem {
  entity: string;
  type: string;
  before: string;
  after: string;
}

export interface EntityScopeRepairReport {
  /** Entities examined (file and symbol entities carrying a scope). */
  examined: number;
  /** Entities whose recovered scope set differs from what is stored. */
  repairable: number;
  /** Entities actually rewritten (0 unless execute). */
  repaired: number;
  /** Sample of the changes, capped for readable output. */
  items: EntityScopeRepairItem[];
  dry_run: boolean;
}

const SAMPLE_LIMIT = 20;

/**
 * Recompute entity scopes from `decided_by` relations.
 *
 * The recovered set is the union of the stored scope (never dropped — it is a
 * real observation, just an incomplete one) and the scopes of every decision
 * entity this entity points at.
 */
export async function repairEntityScopes(
  graphStore: IGraphStore,
  options: { execute?: boolean } = {},
): Promise<EntityScopeRepairReport> {
  const execute = options.execute ?? false;
  const report: EntityScopeRepairReport = {
    examined: 0,
    repairable: 0,
    repaired: 0,
    items: [],
    dry_run: !execute,
  };

  const entities = await graphStore.getEntities();
  const relations = await graphStore.getRelations();

  const byId = new Map(entities.map((e) => [e.id, e]));

  // entity id -> scopes of the decisions it was decided by
  const recovered = new Map<string, Set<string>>();
  for (const rel of relations) {
    if (rel.type !== "decided_by") continue;
    const decision = byId.get(rel.target);
    if (!decision) continue;
    const decisionScope = decision.properties?.scope;
    if (!decisionScope) continue;
    let set = recovered.get(rel.source);
    if (!set) {
      set = new Set<string>();
      recovered.set(rel.source, set);
    }
    // A decision entity's own scope may already be a union post-fix.
    for (const s of splitSetProperty(decisionScope)) set.add(s);
  }

  for (const entity of entities) {
    const stored = entity.properties?.scope;
    if (!stored) continue;
    report.examined++;

    const union = new Set(splitSetProperty(stored));
    for (const s of recovered.get(entity.id) ?? []) union.add(s);

    const after = joinSetProperty([...union]);
    if (after === stored) continue;

    report.repairable++;
    if (report.items.length < SAMPLE_LIMIT) {
      report.items.push({
        entity: entity.name,
        type: entity.type,
        before: stored,
        after,
      });
    }

    if (execute) {
      // addEntity upserts by name+type and now unions `scope`, so passing the
      // recovered set is enough — no direct mutation of the store's internals.
      await graphStore.addEntity({
        name: entity.name,
        type: entity.type,
        properties: { ...entity.properties, scope: after },
      });
      report.repaired++;
    }
  }

  return report;
}
