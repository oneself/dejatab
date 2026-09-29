// Tests for src/rules.js, run with Node's own test runner:
//   node --test test/rules.test.js
// No framework and no dev dependency, which is possible only because the module
// under test touches no browser API.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TRACKING_PARAMS, DEFAULT_RULES, canonicalKey, samePage, explainDifference } from "../src/rules.js";

// Every switch off. Case 1 of the TSD's automated list needs each rule tested on
// its own, and that means a baseline where nothing else is interfering.
const ALL_OFF = {
  ignoreFragment: false,
  ignoreTrailingSlash: false,
  ignoreWww: false,
  ignoreScheme: false,
  dropTrackingParams: false,
  trackingParamsOff: [],
  dropUserParams: false,
  userParams: [],
  dropQuery: false,
  ignoreParamOrder: false,
  sameHost: false,
  samePathPrefix: false,
  pathPrefixSegments: 1,
};

// One rule switched on over that baseline.
const only = (overrides) => ({ ...ALL_OFF, ...overrides });

// Assert a pair matches with the rule on and does not match with it off. This is
// the shape of case 1 for all ten rules: a rule that only ever matched, or only
// ever failed, would pass half a test.
function matchesOnlyWhen(urlA, urlB, overrides) {
  assert.equal(samePage(urlA, urlB, only(overrides)), true, "should match with the rule on");
  assert.equal(samePage(urlA, urlB, ALL_OFF), false, "should not match with the rule off");
}

// --- Case 1: each rule on its own ------------------------------------------

test("R1 ignoreFragment: two anchors into one page", () => {
  matchesOnlyWhen("https://example.com/a#intro", "https://example.com/a#summary", { ignoreFragment: true });
});

test("R2 ignoreTrailingSlash: /docs and /docs/", () => {
  matchesOnlyWhen("https://example.com/docs", "https://example.com/docs/", { ignoreTrailingSlash: true });
});

test("R3 ignoreWww: www.example.com and example.com", () => {
  matchesOnlyWhen("https://www.example.com/a", "https://example.com/a", { ignoreWww: true });
});

test("R4 ignoreScheme: the http and https copies of a page", () => {
  matchesOnlyWhen("http://example.com/a", "https://example.com/a", { ignoreScheme: true });
});

test("R5 dropTrackingParams: a newsletter's utm_source", () => {
  matchesOnlyWhen("https://example.com/a?utm_source=newsletter", "https://example.com/a", { dropTrackingParams: true });
});

test("R6 dropUserParams: a session parameter the user named", () => {
  const rules = only({ dropUserParams: true, userParams: ["sid"] });
  assert.equal(samePage("https://example.com/a?sid=1", "https://example.com/a", rules), true);
  // The switch without the list is inert, which is why it can ship on.
  assert.equal(samePage("https://example.com/a?sid=1", "https://example.com/a", only({ dropUserParams: true })), false);
});

test("R7 dropQuery: two different queries on one path", () => {
  matchesOnlyWhen("https://example.com/a?x=1", "https://example.com/a?y=2", { dropQuery: true });
});

test("R8 ignoreParamOrder: the same pairs in the other order", () => {
  matchesOnlyWhen("https://example.com/a?a=1&b=2", "https://example.com/a?b=2&a=1", { ignoreParamOrder: true });
});

test("R9 sameHost: any two addresses on the host", () => {
  matchesOnlyWhen("https://mail.example.com/inbox", "https://mail.example.com/u/2/x?y=1#z", { sameHost: true });
});

test("R10 samePathPrefix: two issues under /issues", () => {
  matchesOnlyWhen("https://example.com/issues/12", "https://example.com/issues/34", {
    samePathPrefix: true,
    pathPrefixSegments: 1,
  });
});

// --- Case 2: the shipped defaults ------------------------------------------

test("defaults ignore the fragment, a trailing slash and tracking parameters", () => {
  assert.equal(samePage("https://example.com/a#top", "https://example.com/a", {}), true);
  assert.equal(samePage("https://example.com/docs/", "https://example.com/docs", {}), true);
  assert.equal(samePage("https://example.com/a?utm_medium=email", "https://example.com/a", {}), true);
});

test("defaults respect the scheme, the www label, the query and its order", () => {
  assert.equal(samePage("http://example.com/a", "https://example.com/a", {}), false);
  assert.equal(samePage("https://www.example.com/a", "https://example.com/a", {}), false);
  assert.equal(samePage("https://example.com/a?page=2", "https://example.com/a", {}), false);
  assert.equal(samePage("https://example.com/a?x=1&y=2", "https://example.com/a?y=2&x=1", {}), false);
  assert.equal(samePage("https://example.com/issues/12", "https://example.com/issues/34", {}), false);
});

test("a missing rules argument is the shipped defaults", () => {
  // The worker and the options page always pass a resolved rule set, but a
  // partial or absent one must still behave, not throw.
  assert.equal(canonicalKey("https://example.com/a#top"), "https://example.com/a");
  assert.equal(canonicalKey("https://example.com/a#top", null), "https://example.com/a");
  assert.equal(canonicalKey("https://example.com/a#top", { ignoreFragment: false }), "https://example.com/a#top");
});

test("a malformed list field falls back to its default rather than throwing", () => {
  // Stored settings are untrusted on read: a comparison must not be the thing
  // that breaks, because a broken comparison closes nothing but also matches
  // nothing.
  const rules = { trackingParamsOff: "utm_id" };
  assert.equal(canonicalKey("https://example.com/a?utm_id=9", rules), "https://example.com/a");
});

// --- Case 3: the two documented rule interactions --------------------------

test("sameHost overrides the path, query and fragment rules", () => {
  const rules = only({ sameHost: true, samePathPrefix: true, pathPrefixSegments: 3, ignoreFragment: false });
  assert.equal(canonicalKey("https://example.com/a/b/c?x=1#f", rules), "https://example.com");
  assert.equal(samePage("https://example.com/a/b/c?x=1#f", "https://example.com/z", rules), true);
});

test("dropQuery overrides both parameter rules", () => {
  // With no query left, whether R5 and R6 would have removed a name cannot
  // matter: every address on the path has the same key.
  const rules = only({
    dropQuery: true,
    dropTrackingParams: true,
    trackingParamsOff: ["utm_id"],
    dropUserParams: true,
    userParams: ["sid"],
  });
  assert.equal(canonicalKey("https://example.com/a?utm_id=9&sid=1&keep=2", rules), "https://example.com/a");
  assert.equal(samePage("https://example.com/a?utm_id=9", "https://example.com/a?sid=1&other=3", rules), true);
});

// --- Case 4: tracking and user parameters ----------------------------------

test("a tracking name switched off in trackingParamsOff survives", () => {
  const rules = only({ dropTrackingParams: true, trackingParamsOff: ["utm_source"] });
  assert.equal(
    canonicalKey("https://example.com/a?utm_source=news&utm_medium=email", rules),
    "https://example.com/a?utm_source=news",
  );
});

test("a name that merely starts with utm is not in the list and survives", () => {
  const rules = only({ dropTrackingParams: true });
  assert.equal(canonicalKey("https://example.com/a?utm_partner=x", rules), "https://example.com/a?utm_partner=x");
  // Names are compared case-sensitively, the way a server treats them.
  assert.equal(canonicalKey("https://example.com/a?UTM_Source=x", rules), "https://example.com/a?UTM_Source=x");
});

test("user parameters are removed alongside tracking parameters", () => {
  const rules = only({ dropTrackingParams: true, dropUserParams: true, userParams: ["sessionId"] });
  assert.equal(
    canonicalKey("https://example.com/a?sessionId=abc&gclid=1&page=2", rules),
    "https://example.com/a?page=2",
  );
});

test("every one of the sixteen built-in names is dropped", () => {
  assert.equal(TRACKING_PARAMS.length, 16);
  assert.equal(Object.isFrozen(TRACKING_PARAMS), true);
  const query = TRACKING_PARAMS.map((name) => name + "=x").join("&");
  const rules = only({ dropTrackingParams: true });
  assert.equal(canonicalKey("https://example.com/a?" + query, rules), "https://example.com/a");
});

// --- Case 5: parameter order and repeated names ----------------------------

test("ignoreParamOrder sorts by name and then by value", () => {
  const rules = only({ ignoreParamOrder: true });
  assert.equal(canonicalKey("https://example.com/a?b=2&a=1", rules), "https://example.com/a?a=1&b=2");
  assert.equal(canonicalKey("https://example.com/a?a=2&a=1", rules), "https://example.com/a?a=1&a=2");
});

test("repeated parameter names are not collapsed", () => {
  const sorted = only({ ignoreParamOrder: true });
  // Two values of one name are two parameters, in either rule state.
  assert.equal(samePage("https://example.com/a?tag=x&tag=y", "https://example.com/a?tag=y&tag=x", sorted), true);
  assert.equal(samePage("https://example.com/a?tag=x&tag=x", "https://example.com/a?tag=x", sorted), false);
  assert.equal(samePage("https://example.com/a?tag=x&tag=x", "https://example.com/a?tag=x", ALL_OFF), false);
});

test("without ignoreParamOrder the stated order is the key's order", () => {
  assert.equal(canonicalKey("https://example.com/a?b=2&a=1", ALL_OFF), "https://example.com/a?b=2&a=1");
});

// --- Case 6: path prefix edges ---------------------------------------------

test("N greater than the number of segments keeps the whole path", () => {
  const rules = only({ samePathPrefix: true, pathPrefixSegments: 8 });
  assert.equal(canonicalKey("https://example.com/a/b", rules), "https://example.com/a/b");
  assert.equal(samePage("https://example.com/a/b", "https://example.com/a/c", rules), false);
});

test("N of 1 leaves a root path as the root", () => {
  const rules = only({ samePathPrefix: true, pathPrefixSegments: 1 });
  assert.equal(canonicalKey("https://example.com/", rules), "https://example.com/");
  assert.equal(canonicalKey("https://example.com", rules), "https://example.com/");
  assert.equal(samePage("https://example.com/", "https://example.com/a", rules), false);
});

test("a trailing empty segment counts as a segment", () => {
  // "/a/b/" has three segments, the last of them empty, so N=2 truncates it the
  // same way it truncates "/a/b/c" and N=3 keeps the empty one.
  const two = only({ samePathPrefix: true, pathPrefixSegments: 2 });
  assert.equal(canonicalKey("https://example.com/a/b/", two), "https://example.com/a/b");
  const three = only({ samePathPrefix: true, pathPrefixSegments: 3 });
  assert.equal(canonicalKey("https://example.com/a/b/", three), "https://example.com/a/b/");
  // With R2 also on, the truncated path is tidied after the truncation.
  const tidied = only({ samePathPrefix: true, pathPrefixSegments: 3, ignoreTrailingSlash: true });
  assert.equal(canonicalKey("https://example.com/a/b/", tidied), "https://example.com/a/b");
});

// --- Case 7: edge addresses ------------------------------------------------

test("an address that will not parse has no key and matches nothing", () => {
  assert.equal(canonicalKey("not a url", {}), null);
  assert.equal(canonicalKey("example.com/a", {}), null);
  assert.equal(canonicalKey("", {}), null);
  // Not even another copy of itself: an unreadable address must never be the
  // reason a tab closes.
  assert.equal(samePage("not a url", "not a url", {}), false);
  assert.equal(samePage("not a url", "https://example.com/a", {}), false);
});

test("an explicit default port equals the implicit one", () => {
  assert.equal(canonicalKey("https://example.com:443/a", {}), "https://example.com/a");
  assert.equal(canonicalKey("http://example.com:80/a", {}), "http://example.com/a");
  assert.equal(samePage("https://example.com:443/a", "https://example.com/a", {}), true);
  // A port that is not the scheme's default is part of the address.
  assert.equal(canonicalKey("https://example.com:8443/a", {}), "https://example.com:8443/a");
  assert.equal(samePage("https://example.com:8443/a", "https://example.com/a", {}), false);
});

test("the host is lower-cased and the path is not", () => {
  assert.equal(canonicalKey("HTTPS://EXAMPLE.COM/Article", {}), "https://example.com/Article");
  assert.equal(samePage("https://EXAMPLE.com/a", "https://example.com/a", {}), true);
  // Paths are case-sensitive on most servers, so they stay as typed.
  assert.equal(samePage("https://example.com/A", "https://example.com/a", {}), false);
});

test("a fully qualified host is the same page as the plain one", () => {
  // Chrome keeps the root label's dot in hostname, so without this a user who
  // reached a page through the dotted form would never see a prompt: the two
  // spellings would be two pages here while settings.js already calls them one
  // site.
  assert.equal(canonicalKey("https://example.com./a", {}), "https://example.com/a");
  assert.equal(samePage("https://example.com./a", "https://example.com/a", {}), true);
  // The dot comes off before R3, so the fully qualified www form still pairs
  // with its apex.
  assert.equal(samePage("https://www.example.com./a", "https://example.com/a", only({ ignoreWww: true })), true);
  // And it is not a rule the user can switch off, so it holds with every rule
  // off too.
  assert.equal(samePage("https://example.com./a", "https://example.com/a", ALL_OFF), true);
});

test("only one trailing dot comes off", () => {
  // "example.com.." is not a spelling of a real host, and folding it into one
  // would call two different addresses the same page on the strength of a typo.
  assert.equal(canonicalKey("https://example.com../a", {}), "https://example.com./a");
  assert.equal(samePage("https://example.com../a", "https://example.com/a", {}), false);
});

test("an empty query marker leaves no query behind", () => {
  assert.equal(canonicalKey("https://example.com/a?", {}), "https://example.com/a");
  assert.equal(samePage("https://example.com/a?", "https://example.com/a", {}), true);
});

test("a percent-encoded path is compared in one encoding", () => {
  assert.equal(canonicalKey("https://example.com/a%20b", {}), "https://example.com/a%20b");
  assert.equal(samePage("https://example.com/a%20b", "https://example.com/a b", {}), true);
  assert.equal(canonicalKey("https://example.com/caf%C3%A9", {}), "https://example.com/caf%C3%A9");
});

test("ignoreScheme leaves a key that still names the host unambiguously", () => {
  assert.equal(canonicalKey("https://example.com/a", only({ ignoreScheme: true })), "//example.com/a");
});

// --- Case 9: the tester's explanation --------------------------------------

test("matching addresses report the shared key", () => {
  assert.deepEqual(explainDifference("https://example.com/a#top", "https://example.com/a", {}), {
    same: true,
    key: "https://example.com/a",
  });
});

test("every differing pair reports a piece, and the rule that would match it", () => {
  // Each pair differs in exactly one piece, and exactly one switched-off rule
  // brings the two together. The piece is what the user can see; the rule is
  // what they can do about it.
  const cases = [
    ["https://example.com/a#x", "https://example.com/a#y", "fragment", "ignoreFragment"],
    ["https://example.com/docs", "https://example.com/docs/", "path", "ignoreTrailingSlash"],
    ["https://www.example.com/a", "https://example.com/a", "host", "ignoreWww"],
    ["http://example.com/a", "https://example.com/a", "scheme", "ignoreScheme"],
    ["https://example.com/a?utm_id=9", "https://example.com/a", "query", "dropTrackingParams"],
    ["https://example.com/a?x=1&y=2", "https://example.com/a?y=2&x=1", "query", "ignoreParamOrder"],
    ["https://example.com/a?x=1", "https://example.com/a?y=2", "query", "dropQuery"],
    ["https://example.com/issues/12", "https://example.com/issues/34", "path", "samePathPrefix"],
    ["https://example.com/a", "https://example.com/b/c", "path", "sameHost"],
  ];
  for (const [urlA, urlB, piece, rule] of cases) {
    assert.deepEqual(explainDifference(urlA, urlB, ALL_OFF), { same: false, piece, rule }, rule);
  }
});

test("each piece can be named, the port included", () => {
  // The port is a piece of its own: two tabs on one host and one path that reach
  // different ports are different pages, and no rule in the set says otherwise.
  assert.deepEqual(explainDifference("https://example.com:8443/a", "https://example.com/a", ALL_OFF), {
    same: false,
    piece: "port",
    rule: null,
  });
  // A default port is not a difference, because step 4 drops it from both sides.
  assert.deepEqual(explainDifference("https://example.com:443/a", "https://example.com/a", ALL_OFF), {
    same: true,
    key: "https://example.com/a",
  });
});

test("the named rule is the narrowest one that would match the pair", () => {
  // R6 is the rule for a name the built-in list does not carry, even though R7
  // would also make these two equal.
  const rules = only({ userParams: ["sid"] });
  assert.deepEqual(explainDifference("https://example.com/a?sid=1", "https://example.com/a", rules), {
    same: false,
    piece: "query",
    rule: "dropUserParams",
  });
});

test("a rule already on is named neither as the rule nor as the difference", () => {
  // The defaults already ignore the fragment, so the fragments here are equal
  // once the rules have been applied and the path is the first real difference.
  // No narrower switch reaches it, so R9 is the only one left that would.
  assert.deepEqual(explainDifference("https://example.com/a#x", "https://example.com/b#y", {}), {
    same: false,
    piece: "path",
    rule: "sameHost",
  });
});

test("a piece R9 keeps out of the key is still named", () => {
  // This is the case that a comparison of assembled keys could not report: with
  // R9 on the key stops at the host, so the tester has to compare the pieces.
  // These two are the same page under these rules, and the path difference is
  // real but no longer decisive.
  const rules = only({ sameHost: true });
  assert.deepEqual(explainDifference("https://example.com/a", "https://example.com/b", rules), {
    same: true,
    key: "https://example.com",
  });
  // On two hosts, R9 leaves the host as the difference and cannot fix it, while
  // the path difference is behind it and goes unreported.
  assert.deepEqual(explainDifference("https://alpha.com/a", "https://beta.com/b", rules), {
    same: false,
    piece: "host",
    rule: null,
  });
});

test("no switch matches two different hosts, so the rule is null", () => {
  // Nothing in R1 to R10 brings two hosts together, R9 included: it makes one
  // host one page, not two hosts one page.
  assert.deepEqual(explainDifference("https://alpha.com/x", "https://beta.com/x", {}), {
    same: false,
    piece: "host",
    rule: null,
  });
  // Scheme and host both differ, so R4 alone is not enough and the scheme, being
  // the first piece, is what gets named.
  assert.deepEqual(explainDifference("http://alpha.com/x", "https://beta.com/x", {}), {
    same: false,
    piece: "scheme",
    rule: null,
  });
});

test("an address that will not parse is reported by side", () => {
  assert.deepEqual(explainDifference("not a url", "https://example.com/a", {}), { same: false, invalid: "a" });
  assert.deepEqual(explainDifference("https://example.com/a", "not a url", {}), { same: false, invalid: "b" });
  // The first field named is the first one at fault, so the user fixes one at a
  // time rather than being told both are wrong.
  assert.deepEqual(explainDifference("not a url", "also not a url", {}), { same: false, invalid: "a" });
});
test("the shipped defaults are the ones the TSD's table states", () => {
  assert.deepEqual({ ...DEFAULT_RULES }, {
    ignoreFragment: true,
    ignoreTrailingSlash: true,
    ignoreWww: false,
    ignoreScheme: false,
    dropTrackingParams: true,
    trackingParamsOff: [],
    dropUserParams: true,
    userParams: [],
    dropQuery: false,
    ignoreParamOrder: false,
    sameHost: false,
    samePathPrefix: false,
    pathPrefixSegments: 1,
  });
});
