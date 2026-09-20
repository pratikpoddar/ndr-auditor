/**
 * Every incident stores the rule version that produced it. Inference is re-runnable over
 * stored facts, so bumping this and replaying is how rules improve without re-fetching
 * Shopify. Never mutate a rule in place without bumping the version — the audit trail on
 * an existing incident would silently start lying about how it was derived.
 */
export const RULE_VERSION = "2026.09.1";
