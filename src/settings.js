// DejaTab settings: the stored shape, the shipped defaults, storage access, host
// matching for the exclusion list, the allow-list and the per-site lists, rule
// resolution for a host, and the normalisation applied to input typed on the
// options page.
//
// Only loadSettings and saveSettings mention chrome, and they mention it inside
// their own bodies rather than at import time. Every other function here is a
// plain function of its arguments. The split is deliberate: the worker, the
// options page and the address tester all share this module, and the parts that
// decide which rules apply must run under `node --test` with no browser present
// and no stub written. A chrome reference evaluated at import time would break
// that for every caller at once, so the two storage functions are the only
// place it appears.

// The one import: the shipped rule values live in rules.js, and the dependency
// runs in this direction only. rules.js imports nothing, which is what lets it
// fill in a field a caller left out without asking anyone, and one table of
// twelve defaults cannot drift from a second copy that does not exist.
import { DEFAULT_RULES } from "./rules.js";

// The single chrome.storage.sync key everything lives under. One key rather
// than one per section, because the rules are read together on every
// navigation, which makes a single read both simpler and cheaper.
const KEY = "settings";

/**
 * The shipped defaults, exactly as the TSD's Data Model tables state them.
 * Frozen so a caller that forgets to copy cannot edit the shipped values.
 */
export const DEFAULTS = Object.freeze({
  schemaVersion: 1,                       // Lets a later version recognise and migrate an older stored shape.
  bannerTimeoutSeconds: 30,               // Seconds the prompt waits before giving up; 0 waits indefinitely.
  excludedHosts: Object.freeze([]),       // Host entries the extension ignores completely.
  allowListOnly: false,                   // false is "All sites"; true acts only on allowedHosts.
  allowedHosts: Object.freeze([]),        // Host entries acted on while allowListOnly is true.
  sites: Object.freeze([]),               // Per-site entries, each naming only the rules it changes.
  rules: DEFAULT_RULES                    // The twelve rule values, from rules.js.
});

// Puts a host into the form every comparison in this module uses: trimmed,
// lower-cased, and without the trailing dot of a fully qualified name. Hosts are
// case-insensitive, and both stored entries and the host taken from a URL reach
// us in either case. The dot matters more than it looks: a fully qualified host
// carries one for the root label, Chrome keeps it in the URL, so the hostname of
// https://example.com./ is "example.com." and would otherwise miss an exclusion
// entry for example.com. A page could then defeat a user's exclusion just by
// linking to the dotted form [FR-15]. Dropping it here, in the one helper every
// comparison goes through, means no caller can forget it. Exactly one dot goes,
// so a host ending in two dots stays the nonsense it is.
function lower(host) {
  return String(host ?? "").trim().toLowerCase().replace(/\.$/, "");
}

// A stored value is trusted only when it has the same shape as the default it
// would replace. Anything else is nonsense and the field falls back on its own
// rather than taking the whole object down with it [FR-30].
function sameShape(value, fallback) {
  if (Array.isArray(fallback)) return Array.isArray(value);
  if (typeof fallback === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === typeof fallback;
}

// Cleans a rules object field by field. With fillMissing set, every field the
// source leaves out or spoils takes its shipped default, which is what the global
// rules object needs. Without it, only the fields the source actually names
// survive, which is what a per-site override must be: a field it does not
// mention has to keep its global value [FR-18].
function coerceRules(source, fillMissing) {
  const src = source && typeof source === "object" ? source : {};
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULTS.rules)) {
    const ok = sameShape(src[key], fallback);
    if (!ok && !fillMissing) continue;
    // The two list fields are cleaned the way typed input is cleaned, so a
    // stored list holding blanks or non-strings cannot reach the matcher.
    if (Array.isArray(fallback)) out[key] = normalizeParamNames(ok ? src[key] : []);
    else out[key] = ok ? src[key] : fallback;
  }
  // R10's segment count has a documented range, so a stored number outside it is
  // pulled back in rather than handed to the matcher as written.
  if ("pathPrefixSegments" in out) out.pathPrefixSegments = normalizeSegments(out.pathPrefixSegments);
  return out;
}

// Cleans one list of host entries, whether per-site or exclusion. An entry
// without a usable host can never match anything, so it is dropped; everything
// else the entry carries (source, addedAt) is kept as stored, since only the
// options page reads it.
function coerceEntries(value, perSite) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === "object" && lower(entry.host) !== "")
    .map((entry) => {
      const clean = { ...entry, host: lower(entry.host) };
      // A per-site entry also carries partial rules and the autoClose flag.
      if (perSite) {
        // Coerced without filling in what is missing: an unnamed field has to
        // stay unnamed so it keeps inheriting the global value [FR-18].
        clean.rules = coerceRules(entry.rules, false);
        clean.autoClose = entry.autoClose === true;
      }
      return clean;
    });
}

/**
 * Builds a complete settings object out of whatever was stored, falling back
 * field by field. Stored settings are untrusted on read: a missing or malformed
 * field takes its shipped default and the rest of the stored object survives, so
 * one bad field never discards a user's rules [FR-30, TSD Error Handling].
 *
 * Exported because it is the whole of FR-30 and loadSettings, which is the only
 * caller that matters, cannot run outside Chrome. This is the one place settings
 * are cleaned: everything downstream works on what this returned.
 */
export function coerceSettings(stored) {
  const src = stored && typeof stored === "object" ? stored : {};
  const timeout = src.bannerTimeoutSeconds;
  return {
    // The version is only a marker for a future migration, so a spoiled one
    // simply reads as the current version.
    schemaVersion: sameShape(src.schemaVersion, DEFAULTS.schemaVersion)
      ? src.schemaVersion
      : DEFAULTS.schemaVersion,
    // Allowed stored values are 0, or 5 through 600. Anything else is malformed
    // and falls back to the shipped 30 rather than being quietly clamped: a
    // clamp is what typed input gets, not what storage gets.
    bannerTimeoutSeconds: timeout === 0 || (sameShape(timeout, 30) && timeout >= 5 && timeout <= 600)
      ? timeout
      : DEFAULTS.bannerTimeoutSeconds,
    rules: coerceRules(src.rules, true),  // Filled in, since the global object owns every field.
    excludedHosts: coerceEntries(src.excludedHosts, false),
    // A mode that is not a boolean reads as "All sites", the behavior before the
    // mode existed [allow-list FR-4].
    allowListOnly: sameShape(src.allowListOnly, DEFAULTS.allowListOnly) ? src.allowListOnly : DEFAULTS.allowListOnly,
    // Same entry shape as the exclusion list, so the same cleaning [allow-list FR-5].
    allowedHosts: coerceEntries(src.allowedHosts, false),
    sites: coerceEntries(src.sites, true)
  };
}

// True when an entry's host equals the given host or is a suffix of it at a dot
// boundary, so example.com matches example.com and mail.example.com but not
// notexample.com [FR-14, FR-19]. The dot is what makes the suffix honest.
function matchesHost(entryHost, host) {
  return host === entryHost || host.endsWith("." + entryHost);
}

// True when the host matches any entry of a host list, itself or as a subdomain.
// The exclusion list and the allow-list share one entry shape, so they share
// this one scan and cannot drift apart in how they match. An empty host, or a
// list that is not a list, matches nothing.
function onList(host, entries) {
  const target = lower(host);
  if (!target || !Array.isArray(entries)) return false;
  // Entries are normally cleaned by coerceSettings, but a caller may hand in
  // settings from elsewhere, so a hostless entry is skipped rather than trusted.
  return entries.some((entry) => entry && typeof entry.host === "string" && matchesHost(lower(entry.host), target));
}

// How specific an entry is: mail.example.com has three labels and beats
// example.com's two.
function labelCount(host) {
  return host.split(".").length;
}

/**
 * The host of an address, lower-cased and without the trailing dot of a fully
 * qualified name, or null when the address will not parse or carries no host at
 * all. This is the one way a host is taken out of a URL: it runs the same helper
 * isExcluded, isAllowed and resolveRules run on their arguments, so a tab's
 * host, a typed entry and a stored entry all end up in one form and none of the
 * three host lists (exclusion, allow-list, per-site) can miss a match on a
 * difference of case or a root dot [FR-15, FR-19].
 */
export function hostOf(url) {
  try {
    return lower(new URL(url).hostname) || null;
  } catch {
    return null;
  }
}

/**
 * Reads the settings from chrome.storage.sync and returns a complete object.
 * A read that fails yields the shipped defaults for that read and writes
 * nothing, so a transient storage failure cannot wipe a user's rules.
 */
export async function loadSettings() {
  let stored = null;
  try {
    // One of the two places in this module that touches chrome, on purpose.
    const bag = await chrome.storage.sync.get(KEY);
    stored = bag ? bag[KEY] : null;
  } catch {
    stored = null;
  }
  return coerceSettings(stored);
}

/**
 * Writes the whole settings object under the one key. Returns the outcome
 * instead of throwing, because a caller has to be able to tell the user the
 * write failed: the sync quota and the write-rate limit both surface here, and
 * an Always or Never that was not saved must say so rather than be forgotten
 * silently [TSD Error Handling].
 */
export async function saveSettings(settings) {
  try {
    // The second and last place in this module that touches chrome.
    await chrome.storage.sync.set({ [KEY]: settings });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}

/**
 * True when the host is on the exclusion list, itself or as a subdomain of an
 * entry. Checked before any rule resolution, because exclusion outranks
 * everything, including a per-site entry for the same host [FR-15, FR-16].
 */
export function isExcluded(host, settings) {
  return onList(host, settings && settings.excludedHosts);
}

/**
 * True when the host is on the allow-list, itself or as a subdomain of an
 * entry. It answers only whether the host is listed and ignores the mode, so
 * the address tester can say why a host is not acted on; actsOn is what decides
 * whether DejaTab acts [allow-list FR-5].
 */
export function isAllowed(host, settings) {
  return onList(host, settings && settings.allowedHosts);
}

/**
 * True when DejaTab should act on the host at all: look at its navigations,
 * close its tabs, count it in the sweep. The worker asks only this, so the
 * exclusion list and the allow-list cannot be combined two ways in two places.
 * The steps run in order, and every uncertain path ends in false, so DejaTab
 * never closes a tab on a site the user did not allow [TSD Error Handling].
 */
export function actsOn(host, settings) {
  // An address with no host cannot be on either list, so it is left alone.
  if (!lower(host)) return false;
  // Exclusion is checked first because it wins in both modes [allow-list FR-11].
  if (isExcluded(host, settings)) return false;
  // Only a stored true turns the mode on; anything else is "All sites".
  if (!settings || settings.allowListOnly !== true) return true;
  // With the mode on, only a listed host is acted on, so an empty list acts on
  // nothing [allow-list FR-9, FR-10, FR-15].
  return isAllowed(host, settings);
}

/**
 * Resolves the rules that apply to a host, plus that host's autoClose flag.
 * The global rules are the starting point; the most specific matching per-site
 * entry overlays only the fields it names, and no two entries are ever blended
 * [FR-18, FR-19, FR-20].
 *
 * Expects a settings object that came from loadSettings, or one derived from
 * such an object, because shape is not re-checked here: a caller holding
 * settings from anywhere else, stored bytes or a page's own form state, runs
 * coerceSettings on them first. A partial rules object is fine, since the spread
 * fills a missing field from the same shipped table rules.js would have used
 * anyway. A malformed one is not: a field of the wrong type is passed straight
 * through to the matcher.
 */
export function resolveRules(host, settings) {
  const target = lower(host);
  const rules = { ...DEFAULT_RULES, ...(settings && settings.rules ? settings.rules : null) };
  const entries = settings && Array.isArray(settings.sites) ? settings.sites : [];
  let best = null;
  for (const entry of entries) {
    if (!entry || typeof entry.host !== "string") continue;
    const entryHost = lower(entry.host);
    if (!entryHost || !matchesHost(entryHost, target)) continue;
    // Most dot-separated labels wins. The first entry seen wins a tie, which
    // can only happen when the same host is listed twice.
    if (!best || labelCount(entryHost) > labelCount(lower(best.host))) best = entry;
  }
  if (!best) return { rules, autoClose: false };
  // Only the fields the winning entry names overlay the global values, and its
  // flag rides back with them because the caller needs both in one breath.
  return { rules: { ...rules, ...(best.rules || null) }, autoClose: best.autoClose === true };
}

/**
 * Today as an ISO 8601 date, no time: what both lists record in addedAt.
 * Exported so the options page writes the same date in the same form as an
 * Always or a Never does, from one piece of code rather than two.
 */
export function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Returns a new settings object in which the host closes duplicates without
 * asking. An existing entry for that exact host keeps its rule overrides and
 * only gains the flag, so an Always never rewrites what the user configured
 * [FR-8, TSD Acting on the answer]. The given settings object is not touched.
 */
export function withAlways(host, settings) {
  const target = lower(host);
  const sites = Array.isArray(settings.sites) ? settings.sites : [];
  const existing = sites.some((entry) => entry && lower(entry.host) === target);
  return {
    ...settings,
    sites: existing
      ? sites.map((entry) => (entry && lower(entry.host) === target ? { ...entry, autoClose: true } : entry))
      : [...sites, { host: target, rules: {}, autoClose: true, source: "always", addedAt: today() }]
  };
}

/**
 * Returns a new settings object with the host on the exclusion list, and with
 * the close-without-asking flag cleared on every per-site entry the exclusion
 * shadows. Never means stop touching this site: were the flag left set, removing
 * the exclusion later would silently resume closing tabs on that host without
 * asking, so instead the host starts by asking again [FR-8, FR-16, TSD Acting on
 * the answer]. Nothing else about those entries changes: their rule overrides,
 * source and addedAt stay as they are, and no entry is removed. The given
 * settings object is not touched.
 */
export function withNever(host, settings) {
  const target = lower(host);
  const excluded = Array.isArray(settings.excludedHosts) ? settings.excludedHosts : [];
  const sites = Array.isArray(settings.sites) ? settings.sites : [];
  // The exclusion covers the host and its subdomains, so an entry for
  // mail.example.com is shadowed by a Never on example.com and loses its flag
  // too. Only autoClose is rewritten; the rest of the entry is copied as it is.
  const cleared = sites.map((entry) => {
    if (!entry || typeof entry.host !== "string" || !matchesHost(target, lower(entry.host))) return entry;
    return entry.autoClose === true ? { ...entry, autoClose: false } : entry;
  });
  // An exclusion entry for this exact host already says everything a second one
  // would, so the list itself is left as it is while the flags still clear.
  const alreadyExcluded = excluded.some((entry) => entry && lower(entry.host) === target);
  return {
    ...settings,
    excludedHosts: alreadyExcluded ? excluded : [...excluded, { host: target, source: "never", addedAt: today() }],
    sites: cleared
  };
}

/**
 * Normalises a host typed on the options page: trimmed, lower-cased, with a
 * scheme, userinfo, path, query, fragment and port removed. Returns null when
 * what is left is not a plausible host, which keeps an entry that could never
 * match out of storage and keeps the suffix comparison honest.
 */
export function normalizeHost(input) {
  // Not lower(): the trailing dot is dropped further down instead, once the path
  // and port are gone, so a pasted https://example.com./a normalises too. Doing
  // it in both places would strip two dots and let example.com.. through.
  let host = String(input ?? "").trim().toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");   // A scheme, if one was pasted in.
  host = host.replace(/^[^/?#@]*@/, "");                // Userinfo, before any path could hold an @.
  host = host.split(/[/?#]/)[0];                        // Everything from the path, query or fragment on.
  host = host.replace(/:\d*$/, "");                     // A port, explicit or half-typed.
  // The root label's dot of a fully qualified host, which names the site the
  // user meant. Only one goes, so example.com.. is still rejected below.
  host = host.replace(/\.$/, "");
  // Labels of letters, digits and inner hyphens, joined by dots. This accepts a
  // single label, because localhost is a host a user will want to exclude.
  const plausible = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
  return plausible.test(host) ? host : null;
}

/**
 * Normalises a typed prompt timeout: 0 stands for waiting indefinitely, any
 * other number is pulled into the allowed 5 to 600 range, and anything that
 * does not read as a number falls back to the shipped 30.
 */
export function normalizeTimeout(value) {
  const text = String(value ?? "").trim();
  if (text === "") return DEFAULTS.bannerTimeoutSeconds;
  const seconds = Number(text);
  if (!Number.isFinite(seconds)) return DEFAULTS.bannerTimeoutSeconds;
  if (seconds === 0) return 0;
  return Math.min(600, Math.max(5, Math.round(seconds)));
}

/**
 * Normalises R10's path segment count into its documented 1 to 8 range, rounding
 * a typed fraction and falling back to 1 for anything that does not read as a
 * number. The range lives here alone, so the options page, the rule coercion and
 * the matcher cannot disagree about it.
 */
export function normalizeSegments(value) {
  const wanted = Math.round(Number(String(value ?? "").trim()));
  if (!Number.isFinite(wanted)) return DEFAULT_RULES.pathPrefixSegments;
  return Math.min(8, Math.max(1, wanted));
}

/**
 * Normalises a list of parameter names, given either as the comma-separated
 * string the options page collects or as an already-stored array. Names are
 * trimmed, blanks are dropped and duplicates are removed, with the order the
 * user typed preserved. Anything else is taken as typed, since any string can
 * legally be a parameter name.
 */
export function normalizeParamNames(input) {
  const parts = Array.isArray(input) ? input : String(input ?? "").split(",");
  // A Set keeps insertion order, so it dedupes without disturbing the order.
  return [...new Set(parts.map((part) => String(part ?? "").trim()).filter((part) => part !== ""))];
}
