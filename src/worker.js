// DejaTab's service worker: the only part of the extension that talks to the
// tab, scripting and notification APIs.
//
// Everything here is written for a worker that Chrome starts on an event and
// stops roughly thirty seconds after the last one. Two habits follow from that,
// and between them they explain most of the shape of this file.
//
// 1. Nothing that has to be correct is held in a variable between events. A
//    banner can sit on a page for minutes, far longer than this worker lives,
//    so the question it is asking is written to chrome.storage.session and read
//    back when the answer arrives. Held in a module-level variable it would be
//    gone by then and the user's click would do nothing at all. The same goes
//    for the cleanup sweep's plan, which waits for a confirmation on a page the
//    worker cannot see.
// 2. There is no timer, no alarm, no interval and no long-lived connection
//    anywhere in this file. Anything that woke the worker on a schedule would
//    break FR-32, which promises the extension costs nothing between
//    navigations. The listeners below are registered at the top level, since
//    Chrome needs them in place the moment the worker starts.
//
// The single exception to habit 1 is the settings cache, and it is marked as
// such where it is defined.

import { canonicalKey } from "./rules.js";
import { loadSettings, saveSettings, actsOn, resolveRules, withAlways, withNever, hostOf } from "./settings.js";
import { showBanner } from "./banner.js";

// The session-storage keys. Session storage is memory-backed, never synced and
// cleared when Chrome closes, which is exactly the lifetime a pending question
// and an unconfirmed sweep should have.
const PENDING_KEY = "pending";
const CLEANUP_KEY = "cleanup";

// One notification id per purpose, reused. A burst of closes updates one popup
// instead of stacking several.
const CLOSED_NOTIFICATION_ID = "dejatab-closed";
const SAVE_FAILED_NOTIFICATION_ID = "dejatab-save-failed";

// One hour, and it does two jobs. A question left unanswered this long no longer
// describes the tab strip it was asked about, so it is discarded on read unless
// its banner waits indefinitely. And no question, however patient, suppresses a
// new prompt past this age: see the suppression check in handleNavigation for
// why the cap is on the suppression rather than on the record.
const PENDING_MAX_AGE_MS = 60 * 60 * 1000;

// About sixty characters is what a notification shows without truncating, which
// is what the abbreviated page label has to fit inside.
const LABEL_MAX_LENGTH = 60;

// ---------------------------------------------------------------------------
// The settings cache
// ---------------------------------------------------------------------------

// The one deliberate exception to "the worker keeps no state between events".
// It is a copy of stored data, never the truth: a burst of navigations reads
// storage once rather than once each, and the copy is thrown away the moment
// anything writes to sync storage. It is never trusted to survive, because the
// worker it lives in is stopped whenever Chrome feels like it, and that is
// precisely why it is safe: the worst a stale cache can cost is one extra read
// after a restart.
let settingsCache = null;

// The options page, and this worker's own Always and Never writes, both land
// here. Only the sync area matters; a pending question written to the session
// area must not throw the settings away for nothing.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") settingsCache = null;
});

async function getSettings() {
  if (settingsCache === null) settingsCache = await loadSettings();
  return settingsCache;
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

// Only http and https addresses are ever compared, prompted on or closed.
// Stating that as a whitelist rejects every internal scheme FR-5 names,
// chrome:, chrome-extension:, devtools:, view-source: and about:, along with
// the new tab page and anything Chrome adds later, in one test. A tab whose
// address the extension cannot see at all reads as an empty string and fails
// here too.
function isWebUrl(url) {
  return typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"));
}

// The address as the notification shows it: the host kept whole, the rest
// shortened in the middle so both ends stay readable. The middle is what a long
// address wastes its length on, and the end is where the identifying part of a
// path usually sits, so cutting there keeps more meaning than a plain truncation.
function pageLabel(url) {
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch (error) {
    return String(url).slice(0, LABEL_MAX_LENGTH);
  }
  const host = parsed.host;
  const rest = parsed.pathname + parsed.search;
  const room = LABEL_MAX_LENGTH - host.length;
  if (rest.length <= room) return host + rest;
  // Too little room left for a head, an ellipsis and a tail to say anything, so
  // the host alone is the label.
  if (room < 12) return host;
  const head = Math.ceil((room - 3) / 2);
  const tail = room - 3 - head;
  return host + rest.slice(0, head) + "..." + rest.slice(rest.length - tail);
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

// One query for the whole profile, never one per window [FR-3]. Chrome does the
// filtering: normal windows, finished loading and unpinned, so a tab that could
// never be a duplicate is never marshalled into the worker at all [FR-4, TSD
// Performance].
async function candidateTabs() {
  try {
    return await chrome.tabs.query({ windowType: "normal", status: "complete", pinned: false });
  } catch (error) {
    // A listing that failed means no candidates, which means nothing closes.
    console.debug("DejaTab: tab listing failed", error);
    return [];
  }
}

// The tabs showing the same page as the survivor. Both sides are keyed with the
// survivor's resolved rules, so one comparison never mixes two rule sets: the
// rules of the page the user just landed on decide it [FR-20].
function duplicatesOf(tabs, survivorTabId, survivorKey, rules, settings) {
  return tabs.filter((tab) => {
    if (!tab || typeof tab.id !== "number" || tab.id === survivorTabId) return false;
    if (!isWebUrl(tab.url)) return false;                     // internal pages are never closed [FR-5]
    // An excluded site's tabs are never closed [FR-15], nor, with the allow-list on, an unlisted site's
    // [allow-list FR-10, FR-11].
    if (!actsOn(hostOf(tab.url), settings)) return false;
    return canonicalKey(tab.url, rules) === survivorKey;
  });
}

// Closing is one call per tab, deliberately. A single batched remove fails as a
// whole if any one id is stale, which would leave every other duplicate open;
// one call each means a tab the user already closed is skipped and the rest
// still go [FR-11]. The per-call failure is also the re-validation of an id
// that was collected before the user answered.
async function closeTabs(tabIds) {
  let closed = 0;
  for (const tabId of tabIds) {
    try {
      await chrome.tabs.remove(tabId);
      closed += 1;
    } catch (error) {
      // Already gone. Not an error worth reporting: the tab is in the state the
      // user wanted it in.
    }
  }
  return closed;
}

// A tab by id, or null when it has gone. The tab itself is returned rather than
// a yes or no, because two callers need to look at what it is showing now.
async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (error) {
    return null;
  }
}

// Whether a tab still qualifies for closing, judged now rather than when the
// plan naming it was made.
//
// This is what makes the extension's worst outcome impossible. A plan goes stale
// the moment it is written: between the question and the click, and the window
// is the whole banner timeout, which a timeout of 0 and hover-to-hold stretch
// indefinitely, the user can navigate a matching tab somewhere they care about,
// pin it, or exclude its site by hand or with a Never answered elsewhere. An id
// list closed on trust would take the tab anyway. Every id is therefore a
// candidate that has to earn its close a second time, and a tab that no longer
// matches is left open: the failure mode is a tab that survives, never a tab
// that is lost.
//
// `rules` are the rules the original comparison used, so the user's answer
// settles the comparison they were actually shown. Passing null resolves the
// tab's own host's rules from the settings as they are now, which is what the
// sweep needs, since its plan spans many hosts.
async function stillMatches(tabId, expectedKey, rules, settings) {
  const tab = await getTab(tabId);
  if (tab === null) return false;                            // closed in the meantime
  if (tab.pinned) return false;                              // a pinned tab is never closed [FR-4]
  if (tab.status !== "complete") return false;               // nor is a loading one [FR-4]
  if (!isWebUrl(tab.url)) return false;                      // it went to an internal page [FR-5]
  const host = hostOf(tab.url);
  // Excluded, or dropped from the allow-list or its mode switched, since the plan was made [FR-15,
  // allow-list FR-10, FR-11].
  if (!actsOn(host, settings)) return false;
  const applicable = rules || resolveRules(host, settings).rules;
  // The address itself may have changed. This is the check that catches a
  // background tab the user navigated somewhere else while the banner was up.
  return canonicalKey(tab.url, applicable) === expectedKey;
}

// Closes the tabs in a plan that still match, and returns how many actually
// closed, which is what the user is told.
//
// This re-check is also what makes a long-lived pending question safe: see
// readPending, where a question asked at a timeout of 0 is kept for the whole
// browser session. Those two decisions hold each other up. Entries are { id, key } pairs, so the
// answer path can pass one key for every id while the sweep passes the key each
// tab had when it was counted. A plan written by an earlier version of this
// worker carries no keys, and then nothing matches and nothing closes, which is
// the safe direction.
async function closeStillMatching(entries, rules, settings) {
  let closed = 0;
  for (const entry of entries) {
    // Checked and closed in the same step, one tab at a time. Verifying every
    // entry first and closing the confirmed list afterwards would leave the first
    // tab N awaits between its check and its removal, and anything the user did
    // to it in that window would be missed. This function exists to make a stale
    // plan harmless, so the gap between the check and the close is kept to one
    // await. One call per tab is what FR-11 asks for anyway, so it costs nothing.
    if (!(await stillMatches(entry.id, entry.key, rules, settings))) continue;
    closed += await closeTabs([entry.id]);
  }
  return closed;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

async function notifyClosed(count, label) {
  try {
    await chrome.notifications.create(CLOSED_NOTIFICATION_ID, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: count === 1 ? "DejaTab closed 1 duplicate tab" : "DejaTab closed " + count + " duplicate tabs",
      message: label,
      silent: true
    });
  } catch (error) {
    // A close is never held up or undone by the notification that reports it.
    console.debug("DejaTab: notification failed", error);
  }
}

// An Always or Never that could not be saved has to say so rather than be
// forgotten silently [TSD Error Handling]. A notification is the surface
// chosen because by this point the banner has removed itself and the options
// page is very likely closed, so there is nowhere else the user would see it.
// It is not silent, unlike the close notification: this one needs attention,
// since the setting the user just asked for is not in effect.
async function notifySaveFailed(answer, host, error) {
  try {
    await chrome.notifications.create(SAVE_FAILED_NOTIFICATION_ID, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: "DejaTab could not save that setting",
      message: "\"" + answer + "\" for " + host + " was not stored: " + error + ". Try it again on the options page."
    });
  } catch (failure) {
    console.debug("DejaTab: could not report a failed settings write", failure);
  }
}

// ---------------------------------------------------------------------------
// The pending question
// ---------------------------------------------------------------------------

// Reads the parked question back, discarding one that is too old to describe
// the tab strip any more. Both callers read through here, so the age check
// happens on every read rather than only on the answer path.
async function readPending() {
  let pending = null;
  try {
    const bag = await chrome.storage.session.get(PENDING_KEY);
    pending = bag ? bag[PENDING_KEY] : null;
  } catch (error) {
    return null;
  }
  if (!pending || typeof pending.promptId !== "string") return null;
  // A banner with a timeout of 0 waits indefinitely [FR-9], so the record it
  // depends on must not expire either: an answer given after an hour would
  // otherwise close nothing and say nothing.
  //
  // A record that stays answerable for a whole browser session is only safe
  // because closeStillMatching re-checks every id against survivorKey before
  // anything closes. Without that re-check, an answer given hours later would
  // close whatever those ids point at by then. The two belong together: do not
  // weaken one without reading the other. Every other question is discarded
  // after an hour, because by then it no longer describes the tab strip it was
  // asked about. There is only ever one record, and session storage is cleared
  // when Chrome closes, so a record that never expires cannot accumulate.
  // A record written before this field existed has no timeoutSeconds, which is
  // not 0, so it expires the ordinary way.
  if (pending.timeoutSeconds !== 0) {
    // The comparison is inverted on purpose. A record with a missing or spoiled
    // createdAt yields NaN, and NaN is not less than anything, so it is
    // discarded rather than trusted. Tidied into `>= PENDING_MAX_AGE_MS` this
    // would keep such a record forever, which is the opposite of what an
    // uncertain record should get.
    if (!(Date.now() - pending.createdAt < PENDING_MAX_AGE_MS)) {
      await chrome.storage.session.remove(PENDING_KEY);
      return null;
    }
  }
  return pending;
}

// Parking a question is one read followed by one write, and it must not be
// interleaved with another. A service worker is single-threaded, but an async
// handler yields at every await, and two navigations that complete in the same
// instant do exactly that: both read no pending question, both write one, and
// the second overwrites the first, leaving a live-looking banner whose answer is
// dropped on the promptId mismatch with nothing shown to the user. Re-reading
// immediately before the write narrows that window but does not close it, since
// session storage has no compare-and-set: in lockstep both reads still land
// before either write.
//
// So the read and the write are serialised instead. Each call waits for the
// previous one to settle before it reads, which makes the pair atomic as far as
// this worker is concerned, and two navigations in one instant are always in one
// worker instance. The chain is a module variable, which is safe here because it
// guards nothing across events: a worker that has just started has no work in
// flight, which is exactly what a fresh chain describes.
let parkQueue = Promise.resolve();

function serialize(work) {
  const result = parkQueue.then(work, work);
  // The queue must survive a failed step, or one rejection would wedge every
  // later navigation.
  parkQueue = result.then(() => {}, () => {});
  return result;
}

// Whether a parked question still holds back a new prompt.
//
// Only one question exists at a time [FR-10], with one cap: after an hour a
// question stops suppressing, though it stays answerable while its banner is on
// screen. The reason is a banner with a timeout of 0, which sets no timer, so a
// page that removes the host element parks a question with nothing left to
// answer it, and FR-10 would then silence every other tab for as long as Chrome
// stays open. Capping the suppression rather than the record keeps FR-9's promise
// that 0 waits indefinitely, and the most a page can buy itself is an hour of
// quiet.
//
// Both places that ask "does a question already stand" come through here. They
// have to agree: a cap applied at one of them and not the other would let the
// other go on suppressing, which is the hole this closes.
//
// A record with a spoiled createdAt compares false and suppresses nothing, which
// is the direction an unreadable record should fail in.
//
// A limit that comes with the cap, documented rather than fixed: past the hour
// the one-prompt rule can briefly be false, with an old banner still on screen
// while a new question is parked. Answering the old one hits the promptId
// mismatch and does nothing visible, which is the cost of not verifying from the
// worker that a banner is still alive.
function stillSuppresses(pending) {
  return pending !== null && Date.now() - pending.createdAt < PENDING_MAX_AGE_MS;
}

// Parks the question and puts the banner on the page.
async function ask(survivorTabId, host, duplicateTabIds, label, timeoutSeconds, survivorKey, rules) {
  const pending = {
    promptId: crypto.randomUUID(),   // the banner returns this, which is how a stale answer is spotted
    survivorTabId: survivorTabId,
    host: host,                      // the subject of an Always or a Never
    duplicateTabIds: duplicateTabIds,
    pageLabel: label,
    survivorKey: survivorKey,        // what a duplicate must still key to when the answer arrives
    rules: rules,                    // the rules the question was asked under, so the answer settles that comparison
    createdAt: Date.now(),
    timeoutSeconds: timeoutSeconds   // stored so the record's lifetime matches the banner's
  };
  // The read and the write travel together, for the reason stated above the
  // queue. The injection is deliberately outside the serialised step: it is the
  // slow part, and holding the queue across it would make one unresponsive tab
  // delay the next navigation's decision for nothing.
  //
  // Parked before the injection rather than after it, so there is no instant in
  // which an answer could arrive for a question that has not been written down.
  // If the injection fails the record is removed again below, which leaves the
  // next navigation free to ask.
  const parked = await serialize(async () => {
    // A question that appeared since handleNavigation looked is the one that
    // stands, unless it is past the suppression cap, in which case this one
    // replaces it. The abandoned page is caught the next time it is navigated
    // to, exactly as the suppression rule says [FR-10].
    if (stillSuppresses(await readPending())) return false;
    await chrome.storage.session.set({ [PENDING_KEY]: pending });
    return true;
  });
  if (!parked) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: survivorTabId },
      world: "ISOLATED",            // page scripts cannot call into the banner
      func: showBanner,             // serialised to source and run in the tab
      args: [pending.promptId, {
        count: duplicateTabIds.length,
        pageLabel: label,
        host: host,
        timeoutSeconds: timeoutSeconds
      }]
    });
  } catch (error) {
    // The Chrome Web Store, the PDF viewer, a file address without the
    // file-access setting: pages Chrome refuses to inject into. A question that
    // could not be asked counts as a No, silently. Nothing closes and nothing
    // is shown, because a failure to ask must never become a close.
    console.debug("DejaTab: banner injection failed", error);
    await chrome.storage.session.remove(PENDING_KEY);
  }
}

// ---------------------------------------------------------------------------
// One navigation
// ---------------------------------------------------------------------------

async function handleNavigation(details) {
  // Only the top-level frame. A navigation inside an embedded frame is not an
  // event this extension acts on [FR-1].
  if (details.frameId !== 0) return;
  if (!isWebUrl(details.url)) return;
  // hostOf is settings.js's, so this worker and the options page normalise a host
  // the same way: lower-cased, no port or userinfo, one trailing dot stripped, and
  // null for an address that will not parse. The dot matters here, because the
  // dotted form of a host must resolve the same exclusion, allow-list and per-site
  // entries as the plain form, or the extension would prompt on a site the user
  // excluded, or skip one the user allowed.
  const host = hostOf(details.url);
  if (host === null) return;

  // A question nobody can answer any more must not go on suppressing prompts
  // until its hour is up. The banner died with its document the instant its tab
  // navigated again, so a navigation in that same tab is proof the question is
  // dead; a survivor tab that has gone away entirely is dead for the same
  // reason. So is a tab now showing an internal page: the listener is filtered
  // to http and https, so a survivor that goes to chrome://settings fires no
  // event of its own and never matches details.tabId, which makes this the only
  // place that case can be noticed. It is not a small case either, since a
  // question asked at a timeout of 0 never expires, so a missed one would keep
  // the extension quiet until Chrome closes.
  //
  // This runs before the actsOn check below, and the order is the point: a
  // banner whose own tab then navigates to an excluded or unlisted site is
  // exactly the case that would otherwise leave a dead question suppressing
  // every prompt, because such a host returns early. Clearing costs one memory-backed
  // read on a navigation the extension is about to abandon, which is the
  // cheaper half of the trade.
  let pending = await readPending();
  if (pending !== null) {
    const survivor = await getTab(pending.survivorTabId);
    const dead = pending.survivorTabId === details.tabId || survivor === null || !isWebUrl(survivor.url);
    if (dead) {
      await chrome.storage.session.remove(PENDING_KEY);
      pending = null;
    }
  }

  const settings = await getSettings();
  // Exclusion outranks everything, including a per-site entry for the same
  // host, so it short-circuits before any rule work [FR-15, FR-16]. With the
  // allow-list on, a host not on it is skipped the same way [allow-list FR-9,
  // FR-11].
  if (!actsOn(host, settings)) return;

  const resolved = resolveRules(host, settings);
  const survivorKey = canonicalKey(details.url, resolved.rules);
  // An address that will not parse has no key, which means it matches nothing
  // and therefore never closes a tab.
  if (survivorKey === null) return;

  const tabs = await candidateTabs();
  const duplicates = duplicatesOf(tabs, details.tabId, survivorKey, resolved.rules, settings);
  // The common case, and the cheap one: one settings read, one tab listing, one
  // key per tab, and then nothing at all.
  if (duplicates.length === 0) return;

  const label = pageLabel(details.url);
  const duplicateTabIds = duplicates.map((tab) => tab.id);

  // The host was set to close without asking, by the options page or by an
  // earlier Always. Closing is immediate and the notification is what tells the
  // user it happened, since there was no prompt [FR-12].
  //
  // The ids come from a listing taken several awaits ago, so each one is
  // re-checked at close time exactly as the answer path does: a tab pinned,
  // navigated away, or on a site excluded or dropped from the allow-list in the
  // meantime stays open [TSD "Event flow for one navigation" step 6].
  if (resolved.autoClose) {
    const entries = duplicateTabIds.map((tabId) => ({ id: tabId, key: survivorKey }));
    const closed = await closeStillMatching(entries, resolved.rules, settings);
    if (closed > 0) await notifyClosed(closed, label);
    return;
  }

  // Only one question exists at a time [FR-10]. A redirect chain or a rapid
  // series of navigations therefore produces at most one prompt and nothing
  // queues up behind it; the page this navigation found is caught the next time
  // it is navigated to.
  //
  // With one cap, which stillSuppresses states and explains.
  if (stillSuppresses(pending)) return;

  await ask(details.tabId, host, duplicateTabIds, label, settings.bannerTimeoutSeconds, survivorKey, resolved.rules);
}

// webNavigation.onCompleted fires once per completed navigation, unlike
// tabs.onUpdated which fires again for the title and the favicon, and unlike
// onCommitted which fires per hop of a redirect chain before the page has
// settled. The URL filter is the important half: a filtered-out event does not
// start the worker at all, so an internal page costs nothing beyond what Chrome
// already does [FR-32]. Address changes a page makes to itself do not fire this
// event, which is what FR-34 asks for.
chrome.webNavigation.onCompleted.addListener(handleNavigation, {
  url: [{ schemes: ["http", "https"] }]
});

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

async function handleAnswer(message) {
  const pending = await readPending();
  // No question pending, or an answer from a banner that a newer question has
  // replaced: ignored. The prompt id is also what a page script cannot guess,
  // so this check rejects a forged answer as a side effect.
  if (pending === null || pending.promptId !== message.promptId) return { ok: true };

  // Cleared before anything is acted on, so a double click cannot act twice:
  // the second answer finds nothing pending and stops at the check above.
  await chrome.storage.session.remove(PENDING_KEY);

  // The survivor is the tab the user is looking at and the reason the others
  // count as duplicates. If it has gone away since the question was asked, the
  // answer describes a tab strip that no longer exists, so the question is
  // discarded whole and nothing closes [TSD Error Handling].
  if ((await getTab(pending.survivorTabId)) === null) return { ok: true };

  const answer = message.answer;

  // Yes and Always close now. No and Never close nothing at all.
  if (answer === "yes" || answer === "always") {
    // The ids are candidates, not a decision: each one is confirmed against the
    // tab as it is at this instant, under the settings as they are at this
    // instant, before it is closed. See stillMatches for what can have changed
    // and why a stale plan must never cost the user a tab.
    const settings = await getSettings();
    const entries = pending.duplicateTabIds.map((tabId) => ({ id: tabId, key: pending.survivorKey }));
    const closed = await closeStillMatching(entries, pending.rules, settings);
    // The count names what actually closed, so the notification is true even
    // when the re-check spared some of them.
    if (closed > 0) await notifyClosed(closed, pending.pageLabel);
  }

  // Always and Never write an ordinary setting the options page can show and
  // edit like any other entry [FR-8].
  if (answer === "always" || answer === "never") {
    // Read fresh rather than from the cache: this is a read-modify-write of the
    // whole stored object, and the cache may be a copy taken before the options
    // page wrote to it. Overwriting a change the user just made on that page
    // would be much worse than one extra storage read.
    const settings = await loadSettings();
    const next = answer === "always" ? withAlways(pending.host, settings) : withNever(pending.host, settings);
    const result = await saveSettings(next);
    if (!result.ok) await notifySaveFailed(answer, pending.host, result.error);
  }

  // A No writes nothing at all, and neither does an answer this worker does not
  // recognise. Either way the question is already cleared, so the same page can
  // ask again on the next navigation to it.
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The cleanup sweep
// ---------------------------------------------------------------------------

// Which tab in a duplicate group survives: the one the user is looking at when
// it is in the group, otherwise the most recently accessed, since that is the
// one they are likeliest to return to.
function pickSurvivor(group, currentTabId) {
  const current = group.find((tab) => tab.id === currentTabId);
  if (current) return current;
  // A Chrome that does not report lastAccessed reads as never accessed, which
  // makes the first tab in the group the survivor. That fallback is deliberate:
  // the listing comes back in window and strip order, so the first entry is the
  // leftmost tab of the earliest window, which is a stable and explicable choice
  // rather than an arbitrary one, and every group keeps exactly one survivor
  // whatever Chrome reports.
  return group.reduce((best, tab) => ((tab.lastAccessed || 0) > (best.lastAccessed || 0) ? tab : best), group[0]);
}

// Counts what a sweep would close and parks the plan under a token. The count
// and the confirmation are two separate messages from the options page, and the
// worker can be stopped in between, which is why the plan goes to session
// storage instead of a variable.
async function planCleanup() {
  const settings = await getSettings();
  // Only tabs on sites DejaTab acts on are counted: never an excluded site's, and with the allow-list on,
  // never an unlisted site's [allow-list FR-14].
  const tabs = (await candidateTabs()).filter(
    (tab) => typeof tab.id === "number" && isWebUrl(tab.url) && actsOn(hostOf(tab.url), settings)
  );

  // The tab the user is looking at, resolved once for every group rather than
  // per group. When the sweep is started from the options page that tab is the
  // options page itself, which is not in any group, and then the most recently
  // accessed tab survives instead.
  let currentTabId = -1;
  try {
    const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active.length > 0 && typeof active[0].id === "number") currentTabId = active[0].id;
  } catch (error) {
    // Without it the most recently accessed tab survives, which is the
    // documented fallback anyway.
  }

  // Every tab goes into one key map. Bucketing by raw hostname first would hide
  // exactly the pairs the host rules exist to catch: with R3 on,
  // www.example.com/a and example.com/a are one page and a navigation to either
  // would prompt, yet as strings the hostnames differ, so two separate buckets
  // would each hold one tab and the sweep would report nothing. The sweep has to
  // apply the rules the rest of the extension applies [FR-25].
  //
  // Each tab is keyed with the rules of its own host, and those are resolved
  // once per host through this memo rather than once per tab, which is what
  // grouping by host was for in the first place.
  const rulesByHost = new Map();
  const byKey = new Map();
  for (const tab of tabs) {
    const host = hostOf(tab.url);
    if (!rulesByHost.has(host)) rulesByHost.set(host, resolveRules(host, settings).rules);
    const key = canonicalKey(tab.url, rulesByHost.get(host));
    if (key === null) continue;   // an address that will not parse matches nothing
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(tab);
  }

  const entries = [];
  let groups = 0;
  for (const [key, group] of byKey) {
    if (group.length < 2) continue;
    groups += 1;
    const survivor = pickSurvivor(group, currentTabId);
    for (const tab of group) {
      // The key each tab had when it was counted travels with its id, so the
      // confirmation can tell a tab that still shows this page from one that has
      // moved on since the user read the total.
      if (tab.id !== survivor.id) entries.push({ id: tab.id, key: key });
    }
  }

  const token = crypto.randomUUID();
  await chrome.storage.session.set({ [CLEANUP_KEY]: { token: token, entries: entries } });
  return { ok: true, tabs: entries.length, groups: groups, token: token };
}

// Closes exactly the tabs the matching count found, and nothing it did not.
async function runCleanup(token) {
  let plan = null;
  try {
    const bag = await chrome.storage.session.get(CLEANUP_KEY);
    plan = bag ? bag[CLEANUP_KEY] : null;
  } catch (error) {
    plan = null;
  }
  // A confirmation must match the plan it confirmed. A missing or stale token
  // closes nothing and says so, so the options page can count again rather than
  // close a set of tabs the user never saw a number for.
  if (!plan || typeof token !== "string" || plan.token !== token) {
    return { ok: false, error: "That cleanup count has expired. Count the duplicates again." };
  }
  // Cleared before acting, for the same reason the pending question is: a second
  // confirmation must find nothing to do.
  await chrome.storage.session.remove(CLEANUP_KEY);
  // The same re-check the answer path uses, for the same reason: the tab strip
  // drifts between the count and the confirmation exactly as it drifts between
  // the question and the click, and a tab the user has since navigated, pinned
  // or excluded must survive the sweep. Rules are resolved per tab from the
  // current settings here, because one plan spans many hosts. The reply names
  // how many actually closed, so a user told seven who sees five was told the
  // truth at the time and the truth afterwards.
  const settings = await getSettings();
  const closed = await closeStillMatching(plan.entries || [], null, settings);
  if (closed > 0) await notifyClosed(closed, "Cleaned up duplicates across your open tabs");
  return { ok: true, closed: closed };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Two checks, both cheap: the type names this extension's own protocol, and
  // the sender is this extension rather than a page script or another
  // extension [TSD Security].
  if (!message || typeof message.type !== "string" || !message.type.startsWith("dejatab/")) return false;
  if (!sender || sender.id !== chrome.runtime.id) return false;

  let work = null;
  switch (message.type) {
    case "dejatab/answer":
      work = handleAnswer(message);
      break;
    case "dejatab/cleanup":
      work = planCleanup();
      break;
    case "dejatab/cleanup-go":
      work = runCleanup(message.token);
      break;
    default:
      return false;
  }

  // Returning true keeps the reply channel open until the promise settles,
  // which is what lets the options page wait for a count or a sweep. A rejected
  // promise still answers, because a page waiting forever for a reply is worse
  // than one told the call failed.
  work.then(
    (reply) => sendResponse(reply),
    (error) => sendResponse({ ok: false, error: error && error.message ? error.message : String(error) })
  );
  return true;
});

// FR-22's other half: the toolbar icon opens the options page. The manifest's
// options_ui declaration is what makes it reachable from chrome://extensions.
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});
