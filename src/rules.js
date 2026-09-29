// DejaTab URL comparison.
//
// This module is deliberately free of browser APIs: it takes a URL string and a
// resolved rule set and returns a plain string. That is what lets every
// comparison the extension makes run under Node's test runner, and it is why
// the options page's address tester and the service worker cannot disagree:
// they both come through here.
//
// Two names are used throughout. R1 through R10 are the switches in the PRD's
// "Matching rules" section. The numbered steps in the comments are the steps of
// the TSD's "Canonical key" section, whose order is itself part of the
// specification: later steps depend on what earlier ones left behind.

// R5's built-in tracking parameter list, in the PRD's order. It ships fixed and
// is never fetched from the network, so it belongs in code rather than in
// storage; the only part that is stored is which of these names a user switched
// off, which keeps the stored object small and lets a later release extend this
// list without a migration.
export const TRACKING_PARAMS = Object.freeze([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "msclkid",
  "yclid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "_ga",
]);

// The shipped rule values, from the TSD's "The rules object" table. They live
// here as well as in settings.js on purpose: this module imports nothing, so a
// caller that hands over a partial rule set still gets documented behaviour for
// the fields it left out.
export const DEFAULT_RULES = Object.freeze({
  ignoreFragment: true,           // R1
  ignoreTrailingSlash: true,      // R2
  ignoreWww: false,               // R3
  ignoreScheme: false,            // R4
  dropTrackingParams: true,       // R5
  trackingParamsOff: Object.freeze([]),
  dropUserParams: true,           // R6, inert while userParams is empty
  userParams: Object.freeze([]),
  dropQuery: false,               // R7
  ignoreParamOrder: false,        // R8
  sameHost: false,                // R9
  samePathPrefix: false,          // R10
  pathPrefixSegments: 1,          // the N of R10
});

// The switches explainDifference offers, ordered by how much of an address each
// one discards, narrowest first. This is R1 to R10 order with two swaps, and
// both come from the specification's own statements about which rule subsumes
// which: R7 makes R5, R6 and R8 irrelevant, and R9 makes R10 irrelevant. Trying
// them narrowest first is what makes the answer usable, since the rule named is
// then the smallest one that would match the pair. In plain R1 to R10 order the
// broad rules would answer first and R8 and R10 could never be named at all.
const RULE_SWITCHES = Object.freeze([
  "ignoreFragment",
  "ignoreTrailingSlash",
  "ignoreWww",
  "ignoreScheme",
  "dropTrackingParams",
  "dropUserParams",
  "ignoreParamOrder",
  "dropQuery",
  "samePathPrefix",
  "sameHost",
]);

// The pieces of an address, in the order the tester names the first one that
// differs. They are compared as pieces rather than as substrings of an assembled
// key, because a key leaves pieces out: under R9 it stops at the host, and a
// path difference the user can plainly see would otherwise have no name.
//
// This is deliberately not every key canonicalParts returns. It is the pieces an
// address is made of, and nothing else: the parts object also carries sameHost,
// which is a rule flag that rides along because assembly needs it, and which
// must never be compared as though it were part of an address.
const PIECES = Object.freeze(["scheme", "host", "port", "path", "query", "fragment"]);

// Fill in whatever the caller left out. Only missing fields take a default: a
// field the caller set, even to a value this module would not choose, is the
// caller's decision. A list field that is not a list is treated as missing,
// because stored settings are untrusted on read and the alternative is throwing
// out of a comparison, which would stop the extension rather than a tab.
function withDefaults(rules) {
  const resolved = { ...DEFAULT_RULES };
  if (!rules) return resolved;
  for (const name of Object.keys(DEFAULT_RULES)) {
    const value = rules[name];
    if (value === undefined || value === null) continue;
    if (Array.isArray(DEFAULT_RULES[name]) && !Array.isArray(value)) continue;
    resolved[name] = value;
  }
  return resolved;
}

// Order two parameters by name and then by value, comparing code unit by code
// unit. localeCompare would order them differently on differently configured
// machines, and a key that depends on the machine is not a key.
function comparePair([nameA, valueA], [nameB, valueB]) {
  if (nameA !== nameB) return nameA < nameB ? -1 : 1;
  if (valueA !== valueB) return valueA < valueB ? -1 : 1;
  return 0;
}

// Step 6: the path.
function canonicalPath(pathname, rules) {
  let path = pathname;
  // R10 keeps the first N segments and drops the rest, so "/issues/12" and
  // "/issues/34" are one page at N=1. A parsed pathname always starts with "/",
  // so splitting gives an empty first label which slice(1) discards. A trailing
  // slash leaves a final empty segment, and counting it as a segment is what
  // makes "/a/" truncate the way "/a/b" does. N larger than the number of
  // segments present simply keeps the whole path: it is not an error.
  if (rules.samePathPrefix) {
    path = "/" + pathname.split("/").slice(1, 1 + rules.pathPrefixSegments).join("/");
  }
  // R2 removes one trailing slash, unless the path is just the root, where the
  // slash is the whole path and removing it would leave nothing to compare. It
  // runs after R10 so a path R10 truncated is tidied too.
  if (rules.ignoreTrailingSlash && path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  return path;
}

// Step 7: the query.
function canonicalQuery(parsed, rules) {
  // R7 drops the query outright. This is the whole of the second documented
  // interaction: R5 and R6 become irrelevant because nothing is left to filter.
  if (rules.dropQuery) return "";

  // A list of pairs rather than a map, because a repeated parameter name is two
  // parameters and collapsing it would call two different pages one page.
  let pairs = [...parsed.searchParams];

  // R5 removes every built-in tracking name the user has not switched off.
  // Names are compared case-sensitively, the way a server treats them, so
  // "UTM_Source" is not the tracking parameter "utm_source", and a name that
  // merely begins with "utm" is not in the list and survives.
  if (rules.dropTrackingParams) {
    pairs = pairs.filter(([name]) => !TRACKING_PARAMS.includes(name) || rules.trackingParamsOff.includes(name));
  }
  // R6 removes exactly the names the user typed. With its default empty list it
  // is inert, which is why it can ship on.
  if (rules.dropUserParams) {
    pairs = pairs.filter(([name]) => !rules.userParams.includes(name));
  }
  // R8 sorts the survivors, so "?a=1&b=2" and "?b=2&a=1" are one page.
  if (rules.ignoreParamOrder) {
    pairs.sort(comparePair);
  }
  // Re-serialising through URLSearchParams gives both sides of a comparison the
  // same encoding, so two spellings of one value cannot split a page in two.
  // An empty query, including a bare "?" with nothing after it, yields "" and
  // so disappears from the key entirely.
  return new URLSearchParams(pairs).toString();
}

// Steps 1 to 8: turn an address into the pieces a key is made of, or null when
// it will not parse. Kept separate from the key itself because the tester needs
// the pieces to name the one that differs.
function canonicalParts(url, rules) {
  let parsed;
  // Step 1. An address that does not parse yields no key at all, which means the
  // tab it belongs to can never match anything and so can never close anything.
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const resolved = withDefaults(rules);

  // Step 2. Dropping the scheme (R4) makes the http and https copies of a page
  // one page. Keeping it is the default, so they stay two pages.
  const scheme = resolved.ignoreScheme ? "" : parsed.protocol;

  // Step 3. The host, lower-cased: parsing already lower-cases an ASCII host,
  // and the call stays so the guarantee does not rest on that.
  let host = parsed.hostname.toLowerCase();
  // A single trailing dot is the fully qualified spelling of the same host, and
  // Chrome keeps it in .hostname, so it comes off unconditionally: it is not a
  // rule the user can switch, it is one host written two ways. One dot only,
  // which is where settings.js draws the same line when it matches hosts, so a
  // doubled dot stays the implausible host it looks like rather than being
  // folded into a real one.
  if (host.endsWith(".")) {
    host = host.slice(0, -1);
  }
  // R3 strips one leading "www." only, because stripping repeatedly would invent
  // a host that the user never visited. It runs after the trailing dot so the
  // fully qualified "www.example.com." still pairs with its apex.
  if (resolved.ignoreWww && host.startsWith("www.")) {
    host = host.slice(4);
  }

  // Step 4. The port, unless it is the scheme's default. URL leaves .port empty
  // for a default port whether the address spelled it out or not, so the
  // explicit ":443" and the implicit form agree here with no table of our own.
  const port = parsed.port;

  return {
    scheme,
    host,
    port,
    path: canonicalPath(parsed.pathname, resolved),
    query: canonicalQuery(parsed, resolved),
    // Step 8. R1 is on by default, so the several "#section" links into one
    // article collapse into that article. The parsed hash carries its own "#".
    fragment: resolved.ignoreFragment ? "" : parsed.hash,
    // Step 5 is applied when the key is assembled rather than here. R9 stops the
    // key at the host, but the tester still has to be able to say "the paths
    // differ", so the later pieces are computed and then left out of the key
    // rather than never computed at all. The key is the same either way, and the
    // cost is one split and one query pass on hosts where R9 is switched on.
    sameHost: resolved.sameHost,
  };
}

// Step 9: join the surviving pieces into the one string that is the key. The
// separators cannot be ambiguous: once URL has parsed an address its path holds
// no raw "?" or "#", so an empty query can never be mistaken for path text.
function assemble(parts) {
  const authority = parts.port ? parts.host + ":" + parts.port : parts.host;
  // Step 5. R9 makes every address on the host one page, which is the first
  // documented interaction: R10, the query rules and R1 all stop mattering
  // because the pieces they act on are not in the key.
  if (parts.sameHost) return parts.scheme + "//" + authority;
  const query = parts.query ? "?" + parts.query : "";
  return parts.scheme + "//" + authority + parts.path + query + parts.fragment;
}

// The canonical key of an address under a rule set. Two tabs are duplicates
// when their keys are identical strings. Returns null for an address that will
// not parse.
export function canonicalKey(url, rules) {
  const parts = canonicalParts(url, rules);
  return parts === null ? null : assemble(parts);
}

export function samePage(urlA, urlB, rules) {
  const keyA = canonicalKey(urlA, rules);
  const keyB = canonicalKey(urlB, rules);
  // An unreadable address matches nothing at all, another copy of itself
  // included: uncertainty about what a tab is showing must end with that tab
  // staying open.
  return keyA !== null && keyB !== null && keyA === keyB;
}

// Explain a comparison in the terms the address tester reports:
//   { same: true, key }              one page, and this string is it
//   { same: false, piece, rule }     what differs, and the switch that would
//                                    match them, or null when none would
//   { same: false, invalid }         "a" or "b", the address that will not parse
//
// Both fields are answered because they answer different questions. The piece is
// what the user can see for themselves and is always present, so the tester
// leads with it. The rule is the action available, and there may be none.
export function explainDifference(urlA, urlB, rules) {
  // Parsing failures are named before anything else, since there is nothing to
  // compare and the user needs to know which field to fix.
  const partsA = canonicalParts(urlA, rules);
  if (partsA === null) return { same: false, invalid: "a" };
  const partsB = canonicalParts(urlB, rules);
  if (partsB === null) return { same: false, invalid: "b" };

  const keyA = assemble(partsA);
  const keyB = assemble(partsB);
  if (keyA === keyB) return { same: true, key: keyA };

  // The first piece that differs, compared after the rules that are on have been
  // applied to each piece, so a rule the user already switched on is never
  // reported as a difference. Pieces R9 keeps out of the key are compared too,
  // which is why this reads the pieces and not the keys.
  const piece = PIECES.find((name) => partsA[name] !== partsB[name]);

  // Then the switch that would match the pair: each rule the user has off, tried
  // one at a time. One rule at a time is the point, since the answer has to be a
  // single switch the user can go and flip. Null when no one switch would do it,
  // which is the honest answer for two different hosts.
  const resolved = withDefaults(rules);
  for (const name of RULE_SWITCHES) {
    if (resolved[name]) continue;
    const trial = { ...resolved, [name]: true };
    if (canonicalKey(urlA, trial) === canonicalKey(urlB, trial)) {
      return { same: false, piece, rule: name };
    }
  }
  return { same: false, piece, rule: null };
}
