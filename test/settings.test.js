// Tests for the pure parts of src/settings.js, run with Node's own test runner:
// `node --test test/settings.test.js`. No framework and no dependency.
//
// loadSettings and saveSettings are deliberately absent: they are the only two
// functions in the module that touch chrome, so they cannot run here, and the
// manual release checklist covers them. Everything tested below is a plain
// function of its arguments, which is why this file needs no stub at all.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  coerceSettings,
  DEFAULTS,
  hostOf,
  isExcluded,
  normalizeHost,
  normalizeParamNames,
  normalizeSegments,
  normalizeTimeout,
  resolveRules,
  withAlways,
  withNever
} from "../src/settings.js";

// A settings object built the way loadSettings would return one, so a test can
// name just the parts it cares about.
function settings(overrides = {}) {
  return {
    schemaVersion: 1,
    bannerTimeoutSeconds: 30,
    rules: { ...DEFAULTS.rules },
    excludedHosts: [],
    sites: [],
    ...overrides
  };
}

test("the shipped defaults are the ones the data model states", () => {
  assert.equal(DEFAULTS.schemaVersion, 1);
  assert.equal(DEFAULTS.bannerTimeoutSeconds, 30);
  assert.deepEqual(DEFAULTS.excludedHosts, []);
  assert.deepEqual(DEFAULTS.sites, []);
  // The two rules on by default plus tracking removal, everything else off.
  assert.equal(DEFAULTS.rules.ignoreFragment, true);
  assert.equal(DEFAULTS.rules.ignoreTrailingSlash, true);
  assert.equal(DEFAULTS.rules.dropTrackingParams, true);
  assert.equal(DEFAULTS.rules.dropUserParams, true);
  assert.equal(DEFAULTS.rules.ignoreWww, false);
  assert.equal(DEFAULTS.rules.ignoreScheme, false);
  assert.equal(DEFAULTS.rules.dropQuery, false);
  assert.equal(DEFAULTS.rules.ignoreParamOrder, false);
  assert.equal(DEFAULTS.rules.sameHost, false);
  assert.equal(DEFAULTS.rules.samePathPrefix, false);
  assert.deepEqual(DEFAULTS.rules.trackingParamsOff, []);
  assert.deepEqual(DEFAULTS.rules.userParams, []);
  assert.equal(DEFAULTS.rules.pathPrefixSegments, 1);
});

test("the shipped defaults cannot be edited by a caller", () => {
  assert.throws(() => {
    DEFAULTS.bannerTimeoutSeconds = 1;
  }, TypeError);
  assert.throws(() => {
    DEFAULTS.rules.sameHost = true;
  }, TypeError);
});

test("an exclusion entry matches its own host and its subdomains", () => {
  const stored = settings({ excludedHosts: [{ host: "example.com", source: "user", addedAt: "2026-09-27" }] });
  assert.equal(isExcluded("example.com", stored), true);
  assert.equal(isExcluded("mail.example.com", stored), true);
  assert.equal(isExcluded("a.b.example.com", stored), true);
});

test("an exclusion entry does not match a host that merely ends in the same letters", () => {
  const stored = settings({ excludedHosts: [{ host: "example.com" }] });
  assert.equal(isExcluded("notexample.com", stored), false);
  assert.equal(isExcluded("example.com.evil.test", stored), false);
  assert.equal(isExcluded("example.org", stored), false);
});

test("exclusion ignores case and an empty list excludes nothing", () => {
  assert.equal(isExcluded("MAIL.Example.COM", settings({ excludedHosts: [{ host: "Example.com" }] })), true);
  assert.equal(isExcluded("example.com", settings()), false);
  assert.equal(isExcluded("", settings({ excludedHosts: [{ host: "example.com" }] })), false);
});

test("a host with no matching entry resolves to the global rules and no autoClose", () => {
  const stored = settings({ rules: { ...DEFAULTS.rules, ignoreWww: true } });
  const resolved = resolveRules("example.com", stored);
  assert.equal(resolved.autoClose, false);
  assert.equal(resolved.rules.ignoreWww, true);
  assert.deepEqual(resolved.rules, { ...DEFAULTS.rules, ignoreWww: true, trackingParamsOff: [], userParams: [] });
});

test("a per-site entry overlays only the fields it names", () => {
  const stored = settings({ sites: [{ host: "example.com", rules: { sameHost: true }, autoClose: false }] });
  const resolved = resolveRules("mail.example.com", stored);
  assert.equal(resolved.rules.sameHost, true);          // The field the entry names.
  assert.equal(resolved.rules.ignoreFragment, true);    // Unnamed, so still the global value.
  assert.equal(resolved.rules.ignoreWww, false);        // Unnamed, so still the global value.
  assert.equal(resolved.rules.pathPrefixSegments, 1);   // Unnamed, so still the global value.
});

test("the most specific matching entry wins and the two are never blended", () => {
  const stored = settings({
    sites: [
      { host: "example.com", rules: { ignoreWww: true, dropQuery: true } },
      { host: "mail.example.com", rules: { sameHost: true } }
    ]
  });
  const resolved = resolveRules("mail.example.com", stored);
  assert.equal(resolved.rules.sameHost, true);   // From the winning three-label entry.
  assert.equal(resolved.rules.ignoreWww, false); // The two-label entry contributes nothing.
  assert.equal(resolved.rules.dropQuery, false); // Not blended in either.
});

test("the less specific entry still applies to a host the specific one does not match", () => {
  const stored = settings({
    sites: [
      { host: "example.com", rules: { dropQuery: true } },
      { host: "mail.example.com", rules: { sameHost: true } }
    ]
  });
  const resolved = resolveRules("www.example.com", stored);
  assert.equal(resolved.rules.dropQuery, true);
  assert.equal(resolved.rules.sameHost, false);
});

test("a per-site entry does not reach a host that merely ends in the same letters", () => {
  const stored = settings({ sites: [{ host: "example.com", rules: { sameHost: true }, autoClose: true }] });
  const resolved = resolveRules("notexample.com", stored);
  assert.equal(resolved.rules.sameHost, false);
  assert.equal(resolved.autoClose, false);
});

test("the matching entry's autoClose flag rides back with the rules", () => {
  const stored = settings({
    sites: [
      { host: "example.com", rules: {}, autoClose: true },
      { host: "other.test", rules: {}, autoClose: false }
    ]
  });
  assert.equal(resolveRules("news.example.com", stored).autoClose, true);
  assert.equal(resolveRules("other.test", stored).autoClose, false);
});

test("a malformed global rules object falls back field by field, not wholesale", () => {
  const clean = coerceSettings({
    rules: {
      ignoreFragment: "yes",    // Malformed: takes the shipped default, true.
      ignoreWww: true,          // Well formed: survives, although it differs from the default.
      pathPrefixSegments: null, // Malformed: takes the shipped default, 1.
      userParams: "sid"         // Malformed: a list was expected, so it empties.
    }
  });
  assert.equal(clean.rules.ignoreFragment, true);
  assert.equal(clean.rules.ignoreWww, true);        // The one good field is not thrown out with the bad ones.
  assert.equal(clean.rules.pathPrefixSegments, 1);
  assert.deepEqual(clean.rules.userParams, []);
  assert.equal(clean.rules.dropTrackingParams, true); // Missing entirely, so the default.
});

test("stored settings that are nonsense read as the shipped defaults", () => {
  for (const stored of [null, undefined, "settings", 7, [], {}]) {
    assert.deepEqual(coerceSettings(stored), {
      schemaVersion: 1,
      bannerTimeoutSeconds: 30,
      rules: { ...DEFAULTS.rules, trackingParamsOff: [], userParams: [] },
      excludedHosts: [],
      sites: []
    });
  }
});

test("a stored timeout outside the allowed range falls back to 30, and 0 survives", () => {
  assert.equal(coerceSettings({ bannerTimeoutSeconds: 0 }).bannerTimeoutSeconds, 0);     // Indefinitely.
  assert.equal(coerceSettings({ bannerTimeoutSeconds: 45 }).bannerTimeoutSeconds, 45);
  assert.equal(coerceSettings({ bannerTimeoutSeconds: 700 }).bannerTimeoutSeconds, 30);
  assert.equal(coerceSettings({ bannerTimeoutSeconds: 2 }).bannerTimeoutSeconds, 30);
  assert.equal(coerceSettings({ bannerTimeoutSeconds: "45" }).bannerTimeoutSeconds, 30); // Storage is not typing.
});

test("a stored entry with no usable host is dropped and the rest of the list survives", () => {
  const clean = coerceSettings({
    excludedHosts: [{ host: "kept.test" }, { host: "" }, null, "other.test", { host: "Dotted.Test." }],
    sites: [{ host: "a.test", rules: {}, autoClose: true }, { nothing: true }]
  });
  assert.deepEqual(clean.excludedHosts.map((entry) => entry.host), ["kept.test", "dotted.test"]);
  assert.deepEqual(clean.sites.map((entry) => entry.host), ["a.test"]);
});

test("rules missing altogether resolve to the shipped defaults", () => {
  const shipped = { ...DEFAULTS.rules, trackingParamsOff: [], userParams: [] };
  assert.deepEqual(resolveRules("example.com", {}).rules, shipped);
  assert.equal(resolveRules("example.com", {}).autoClose, false);
});

test("a malformed field in a per-site override is dropped rather than overlaid", () => {
  // The override is cleaned on read, so what reaches resolveRules names only the
  // fields that can mean something, and the global value stands for the rest.
  const clean = coerceSettings({ sites: [{ host: "example.com", rules: { sameHost: 1, dropQuery: true } }] });
  assert.deepEqual(clean.sites[0].rules, { dropQuery: true });
  const resolved = resolveRules("example.com", clean);
  assert.equal(resolved.rules.sameHost, false);
  assert.equal(resolved.rules.dropQuery, true);
});

test("a stored segment count outside the allowed range is pulled back into it", () => {
  assert.equal(coerceSettings({ rules: { pathPrefixSegments: 99 } }).rules.pathPrefixSegments, 8);
  assert.equal(coerceSettings({ rules: { pathPrefixSegments: 0 } }).rules.pathPrefixSegments, 1);
  const site = coerceSettings({ sites: [{ host: "a.test", rules: { pathPrefixSegments: 12 } }] });
  assert.equal(site.sites[0].rules.pathPrefixSegments, 8);
});

test("normalizeSegments holds R10's count in its documented range", () => {
  assert.equal(normalizeSegments(0), 1);
  assert.equal(normalizeSegments(-3), 1);
  assert.equal(normalizeSegments(1), 1);
  assert.equal(normalizeSegments(8), 8);
  assert.equal(normalizeSegments(9), 8);
  assert.equal(normalizeSegments(99), 8);
  assert.equal(normalizeSegments(2.4), 2);   // Rounded, not truncated.
  assert.equal(normalizeSegments(2.6), 3);
  assert.equal(normalizeSegments("3"), 3);
  assert.equal(normalizeSegments(" 4 "), 4);
  assert.equal(normalizeSegments("deep"), 1);
  assert.equal(normalizeSegments(""), 1);
  assert.equal(normalizeSegments(null), 1);
  assert.equal(normalizeSegments(undefined), 1);
  assert.equal(normalizeSegments(NaN), 1);
  assert.equal(normalizeSegments(Infinity), 1);
});

test("withAlways adds an entry naming its origin and today's date", () => {
  const before = settings();
  const after = withAlways("mail.example.com", before);
  assert.equal(after.sites.length, 1);
  assert.deepEqual(after.sites[0], {
    host: "mail.example.com",
    rules: {},
    autoClose: true,
    source: "always",
    addedAt: new Date().toISOString().slice(0, 10)
  });
  assert.match(after.sites[0].addedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(before.sites, []); // The original object is untouched.
  assert.notEqual(after, before);
  assert.equal(resolveRules("mail.example.com", after).autoClose, true);
});

test("withAlways on an existing entry keeps its overrides and only gains the flag", () => {
  const before = settings({
    sites: [
      { host: "example.com", rules: { sameHost: true }, autoClose: false, source: "user", addedAt: "2026-01-02" }
    ]
  });
  const after = withAlways("example.com", before);
  assert.equal(after.sites.length, 1);
  assert.deepEqual(after.sites[0].rules, { sameHost: true });
  assert.equal(after.sites[0].autoClose, true);
  assert.equal(after.sites[0].source, "user");        // The origin of the entry does not change.
  assert.equal(after.sites[0].addedAt, "2026-01-02"); // Nor does the date it was added.
  assert.equal(before.sites[0].autoClose, false);     // The original entry is untouched.
});

test("withAlways leaves the rest of the settings alone", () => {
  const before = settings({ excludedHosts: [{ host: "other.test" }], bannerTimeoutSeconds: 0 });
  const after = withAlways("example.com", before);
  assert.deepEqual(after.excludedHosts, [{ host: "other.test" }]);
  assert.equal(after.bannerTimeoutSeconds, 0);
  assert.deepEqual(after.rules, before.rules);
});

test("withNever adds an exclusion entry and removes nothing", () => {
  const before = settings({
    excludedHosts: [{ host: "kept.test", source: "user", addedAt: "2026-01-01" }],
    sites: [{ host: "example.com", rules: { sameHost: true }, autoClose: false }]
  });
  const after = withNever("example.com", before);
  assert.equal(after.excludedHosts.length, 2);
  assert.deepEqual(after.excludedHosts[0], { host: "kept.test", source: "user", addedAt: "2026-01-01" });
  assert.deepEqual(after.excludedHosts[1], {
    host: "example.com",
    source: "never",
    addedAt: new Date().toISOString().slice(0, 10)
  });
  assert.equal(after.sites.length, 1);          // The per-site entry stays; exclusion just outranks it.
  assert.equal(before.excludedHosts.length, 1); // The original object is untouched.
  assert.equal(isExcluded("www.example.com", after), true);
});

test("withNever clears the close-without-asking flag on the excluded host", () => {
  const before = settings({
    sites: [
      { host: "example.com", rules: { sameHost: true }, autoClose: true, source: "always", addedAt: "2026-01-02" }
    ]
  });
  const after = withNever("example.com", before);
  assert.equal(after.sites[0].autoClose, false);
  assert.equal(before.sites[0].autoClose, true); // The original entry is untouched.
  // Were the flag left set, removing the exclusion later would resume closing
  // without asking. Cleared, the host starts by asking again.
  assert.equal(resolveRules("example.com", after).autoClose, false);
});

test("withNever clears the flag on a subdomain the exclusion shadows", () => {
  const before = settings({
    sites: [
      { host: "example.com", rules: {}, autoClose: true },
      { host: "mail.example.com", rules: {}, autoClose: true },
      { host: "a.b.example.com", rules: {}, autoClose: true }
    ]
  });
  const after = withNever("example.com", before);
  assert.deepEqual(after.sites.map((entry) => entry.autoClose), [false, false, false]);
});

test("withNever leaves the flag of a host the exclusion does not cover", () => {
  const before = settings({
    sites: [
      { host: "example.com", rules: {}, autoClose: true },
      { host: "notexample.com", rules: {}, autoClose: true },
      { host: "other.test", rules: {}, autoClose: true }
    ]
  });
  const after = withNever("example.com", before);
  assert.deepEqual(after.sites.map((entry) => entry.autoClose), [false, true, true]);
  // A Never on a subdomain does not reach the parent host's entry either.
  const narrow = withNever("mail.example.com", before);
  assert.deepEqual(narrow.sites.map((entry) => entry.autoClose), [true, true, true]);
});

test("withNever changes nothing about a cleared entry but its flag", () => {
  const entry = {
    host: "mail.example.com",
    rules: { sameHost: true, pathPrefixSegments: 3 },
    autoClose: true,
    source: "always",
    addedAt: "2026-01-02"
  };
  const after = withNever("example.com", settings({ sites: [entry] }));
  assert.deepEqual(after.sites[0], { ...entry, autoClose: false });
  assert.deepEqual(after.sites[0].rules, { sameHost: true, pathPrefixSegments: 3 });
  assert.equal(after.sites[0].source, "always");
  assert.equal(after.sites[0].addedAt, "2026-01-02");
  // The overrides still apply to the host, which matters once the exclusion goes.
  assert.equal(resolveRules("mail.example.com", after).rules.sameHost, true);
});

test("withNever on an already excluded host adds no second entry and still clears the flag", () => {
  const before = settings({
    excludedHosts: [{ host: "example.com", source: "user", addedAt: "2026-01-01" }],
    sites: [{ host: "mail.example.com", rules: {}, autoClose: true }]
  });
  const after = withNever("EXAMPLE.com", before);
  assert.deepEqual(after.excludedHosts, before.excludedHosts);
  assert.equal(after.excludedHosts.length, 1);
  assert.equal(after.sites[0].autoClose, false);
});

test("the dotted form of a host is excluded like the plain form", () => {
  // A fully qualified host keeps a trailing dot for the root label, and Chrome
  // keeps it in the URL, so https://example.com./ must not slip past an
  // exclusion entry for example.com [FR-15].
  const stored = settings({ excludedHosts: [{ host: "example.com" }] });
  assert.equal(isExcluded("example.com.", stored), true);
  assert.equal(isExcluded("mail.example.com.", stored), true);
  assert.equal(isExcluded("notexample.com.", stored), false);
  // A dotted entry in storage matches the plain host just as well.
  assert.equal(isExcluded("mail.example.com", settings({ excludedHosts: [{ host: "example.com." }] })), true);
});

test("the dotted form resolves the same per-site entry as the plain form", () => {
  const stored = settings({
    sites: [{ host: "example.com", rules: { sameHost: true }, autoClose: true }]
  });
  const dotted = resolveRules("mail.example.com.", stored);
  assert.deepEqual(dotted, resolveRules("mail.example.com", stored));
  assert.equal(dotted.rules.sameHost, true);
  assert.equal(dotted.autoClose, true);
});

test("a dotted host written by an answer is stored without the dot", () => {
  const before = settings({ sites: [{ host: "example.com", rules: {}, autoClose: true }] });
  assert.equal(withAlways("mail.example.com.", before).sites[1].host, "mail.example.com");
  const after = withNever("example.com.", before);
  assert.equal(after.excludedHosts[0].host, "example.com");
  assert.equal(after.sites[0].autoClose, false); // The dotted Never still clears the flag it shadows.
});

test("hostOf takes the bare host out of an address", () => {
  assert.equal(hostOf("https://example.com/docs/page?q=1#top"), "example.com");
  assert.equal(hostOf("http://example.com"), "example.com");
  // Userinfo and a port are not part of what either list matches on.
  assert.equal(hostOf("https://user:secret@example.com:8443/inbox"), "example.com");
  assert.equal(hostOf("https://example.com:443/"), "example.com");
});

test("hostOf lower-cases the host and drops the root label's dot", () => {
  assert.equal(hostOf("https://Mail.EXAMPLE.com/inbox"), "mail.example.com");
  // Chrome keeps the trailing dot in the URL, so this is the form that would
  // otherwise walk past an exclusion entry for example.com [FR-15].
  assert.equal(hostOf("https://example.com./a"), "example.com");
  assert.equal(hostOf("https://Mail.Example.COM./a"), "mail.example.com");
  const stored = settings({ excludedHosts: [{ host: "example.com" }] });
  assert.equal(isExcluded(hostOf("https://Mail.Example.COM./a"), stored), true);
});

test("hostOf gives null for an address with no host to take", () => {
  assert.equal(hostOf("not an address"), null);
  assert.equal(hostOf("example.com/docs"), null); // No scheme, so it will not parse.
  assert.equal(hostOf(""), null);
  assert.equal(hostOf(null), null);
  assert.equal(hostOf(undefined), null);
  assert.equal(hostOf("file:///home/eyal/page.html"), null); // Parses, but carries no host.
  // A null host matches nothing and resolves to the global rules, which is what
  // an address the extension cannot read should do.
  assert.equal(isExcluded(hostOf("not an address"), settings({ excludedHosts: [{ host: "example.com" }] })), false);
  assert.deepEqual(resolveRules(hostOf("not an address"), settings()).rules, DEFAULTS.rules);
});

test("normalizeHost strips everything that is not the host", () => {
  assert.equal(normalizeHost("  HTTPS://Mail.Example.COM/inbox?x=1#top  "), "mail.example.com");
  assert.equal(normalizeHost("http://example.com"), "example.com");
  assert.equal(normalizeHost("example.com/docs/page"), "example.com");
  assert.equal(normalizeHost("example.com?q=1"), "example.com");
  assert.equal(normalizeHost("example.com#part"), "example.com");
  assert.equal(normalizeHost("example.com:8443"), "example.com");
  assert.equal(normalizeHost("user:secret@example.com"), "example.com");
  assert.equal(normalizeHost("https://user@example.com:443/p"), "example.com");
  assert.equal(normalizeHost("localhost"), "localhost");
  assert.equal(normalizeHost("127.0.0.1:3000"), "127.0.0.1");
  assert.equal(normalizeHost("sub.domain.example.co.uk"), "sub.domain.example.co.uk");
  // The trailing dot of a fully qualified host names the site the user meant.
  assert.equal(normalizeHost("example.com."), "example.com");
  assert.equal(normalizeHost("  HTTPS://Mail.Example.COM./inbox  "), "mail.example.com");
  assert.equal(normalizeHost("example.com.:8443"), "example.com");
});

test("normalizeHost rejects what is not a plausible host", () => {
  assert.equal(normalizeHost(""), null);
  assert.equal(normalizeHost("   "), null);
  assert.equal(normalizeHost("https://"), null);
  assert.equal(normalizeHost("/docs"), null);
  assert.equal(normalizeHost("example .com"), null);
  assert.equal(normalizeHost("-example.com"), null);
  assert.equal(normalizeHost("example..com"), null);
  assert.equal(normalizeHost("."), null);
  assert.equal(normalizeHost(".."), null);
  assert.equal(normalizeHost("example.com.."), null); // Only one root dot is dropped.
  assert.equal(normalizeHost("exa_mple.com"), null);
  assert.equal(normalizeHost(null), null);
  assert.equal(normalizeHost(undefined), null);
});

test("normalizeTimeout keeps 0 as meaning indefinitely", () => {
  assert.equal(normalizeTimeout(0), 0);
  assert.equal(normalizeTimeout("0"), 0);
});

test("normalizeTimeout pulls a value outside the range into it", () => {
  assert.equal(normalizeTimeout(700), 600);
  assert.equal(normalizeTimeout(6000), 600);
  assert.equal(normalizeTimeout(1), 5);
  assert.equal(normalizeTimeout(4.4), 5);
  assert.equal(normalizeTimeout(-20), 5);
});

test("normalizeTimeout keeps a value inside the range and rounds it", () => {
  assert.equal(normalizeTimeout(5), 5);
  assert.equal(normalizeTimeout(45), 45);
  assert.equal(normalizeTimeout("45"), 45);
  assert.equal(normalizeTimeout(" 120 "), 120);
  assert.equal(normalizeTimeout(30.6), 31);
  assert.equal(normalizeTimeout(600), 600);
});

test("normalizeTimeout falls back to 30 for anything unparseable", () => {
  assert.equal(normalizeTimeout("abc"), 30);
  assert.equal(normalizeTimeout(""), 30);
  assert.equal(normalizeTimeout("   "), 30);
  assert.equal(normalizeTimeout(null), 30);
  assert.equal(normalizeTimeout(undefined), 30);
  assert.equal(normalizeTimeout(NaN), 30);
  assert.equal(normalizeTimeout(Infinity), 30);
  assert.equal(normalizeTimeout({}), 30);
});

test("normalizeParamNames reads a comma-separated string", () => {
  assert.deepEqual(normalizeParamNames("sid, ref ,  token"), ["sid", "ref", "token"]);
  assert.deepEqual(normalizeParamNames("sid"), ["sid"]);
  assert.deepEqual(normalizeParamNames(""), []);
  assert.deepEqual(normalizeParamNames("  ,  , "), []);
});

test("normalizeParamNames reads an array, keeps order and drops duplicates", () => {
  assert.deepEqual(normalizeParamNames([" b ", "a", "b", "", "  ", "a"]), ["b", "a"]);
  assert.deepEqual(normalizeParamNames("b,a,b"), ["b", "a"]);
  assert.deepEqual(normalizeParamNames([]), []);
  assert.deepEqual(normalizeParamNames(null), []);
  assert.deepEqual(normalizeParamNames(undefined), []);
});

test("normalizeParamNames takes a name that is not a word as typed", () => {
  // Any string can legally be a parameter name, so only trimming applies.
  assert.deepEqual(normalizeParamNames(" utm_source , _ga , X-Odd.Name "), ["utm_source", "_ga", "X-Odd.Name"]);
});
