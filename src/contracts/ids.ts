/**
 * Identity syntax (ADR §1.2, §2.1, R01). Every identity is a ULID; prefixed
 * forms name the identity KIND so a principal id can never be confused with
 * a record id or a repository id. Names, paths, URLs and branches are labels
 * and never appear here.
 */
import { z } from "zod";
import { generateId } from "../utils/ids.js";

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const ulidSchema = z.string().regex(ULID_RE, "expected a ULID");

function prefixed(prefix: string, label: string) {
  return z
    .string()
    .regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`), `expected ${label} id (${prefix}_<ULID>)`);
}

export const principalIdSchema = prefixed("p", "principal");
export const hostIdSchema = prefixed("h", "host");
export const keyIdSchema = prefixed("k", "key");
export const repoIdSchema = prefixed("r", "repository");
export const tenantIdSchema = prefixed("t", "tenant");
export const storeIdSchema = prefixed("s", "store");
/** Worktree token: opaque, minted per linked worktree; not a path. */
export const worktreeTokenSchema = z.string().regex(/^wt_[0-9a-f]{16}$/, "expected worktree token");
export const gitShaSchema = z.string().regex(/^[0-9a-f]{40}$/, "expected a full 40-hex git sha");

export const mintEventId = (): string => generateId();
export const mintPrincipalId = (): string => `p_${generateId()}`;
export const mintHostId = (): string => `h_${generateId()}`;
export const mintKeyId = (): string => `k_${generateId()}`;
export const mintRepoId = (): string => `r_${generateId()}`;
export const mintTenantId = (): string => `t_${generateId()}`;
export const mintStoreId = (): string => `s_${generateId()}`;
