/**
 * ULID generation wrapper.
 * All IDs in Twining are ULIDs — temporally sortable, unique across concurrent agents.
 */
import { monotonicFactory } from "ulid";

const _ulid = monotonicFactory();

export function generateId(): string {
  return _ulid();
}
