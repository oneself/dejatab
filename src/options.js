// DejaTab options page.
//
// The page is the product: it is where the definition of "the same page" is written, and it is the
// only place the extension ever explains itself. Three things shape the code below.
//
// 1. Every change is written through saveSettings the moment it is made [FR-26]. There is no Save
//    button, so a write that fails must be said out loud rather than lost [TSD Error Handling].
// 2. The address tester runs through the same rules.js the service worker uses, with the rules
//    resolved for the first address's host, so the tester cannot disagree with the matcher [FR-24].
// 3. The rule wording lives in one table, RULE_META, which drives the global rule rows, the
//    per-site editor, the summary chips on a per-site entry, and the tester's verdict. One table
//    means the name a user reads in the verdict is the name on the switch they have to go and flip.
//
// The markup in options.html is the fixed frame; every list, row and verdict here is built in the
// DOM rather than with innerHTML, because a host, a parameter name and an address are all user
// input, and text nodes cannot be anything but text.

import { TRACKING_PARAMS, canonicalKey, explainDifference } from "./rules.js";
import {
  DEFAULTS,
  hostOf,
  isAllowed,
  isExcluded,
  loadSettings,
  normalizeHost,
  normalizeParamNames,
  normalizeSegments,
  normalizeTimeout,
  resolveRules,
  saveSettings,
  today
} from "./settings.js";

// The ten rules of the PRD's "Matching rules" section, in the order FR-23 fixes, each with the
// plain sentence and the example pair the Design Considerations require. `field` is the name in the
// stored rules object, so this table is also the mapping from a control to storage. {N} in a label
// is where R10's segment count goes, both in the row and in a per-site summary chip.
const RULE_META = [
  {
    field: "ignoreFragment",
    label: "Ignore the part after #",
    example: ["example.com/post#intro", "example.com/post"]
  },
  {
    field: "ignoreTrailingSlash",
    label: "Ignore a trailing slash",
    example: ["example.com/docs/", "example.com/docs"]
  },
  {
    field: "ignoreWww",
    label: "Ignore a leading www.",
    example: ["www.example.com/a", "example.com/a"]
  },
  {
    field: "ignoreScheme",
    label: "Ignore http and https",
    example: ["http://example.com/a", "https://example.com/a"]
  },
  {
    field: "dropTrackingParams",
    label: "Drop known tracking parameters",
    example: ["example.com/a?utm_source=news", "example.com/a"],
    note: "The 16 parameters are listed below and can be switched off one by one."
  },
  {
    field: "dropUserParams",
    label: "Drop parameters you name",
    desc: "Removed in addition to the tracking list. Separate names with commas.",
    // R6's own field. The rule is inert while the list is empty, which is why it ships on.
    text: { field: "userParams", label: "Parameter names to drop", placeholder: "session_id, ref" }
  },
  {
    field: "dropQuery",
    label: "Drop everything after ?",
    example: ["example.com/search?q=cats", "example.com/search"],
    note: "Makes the two rules above irrelevant while it is on."
  },
  {
    field: "ignoreParamOrder",
    label: "Ignore the order of parameters",
    example: ["example.com/a?a=1&b=2", "example.com/a?b=2&a=1"]
  },
  {
    field: "sameHost",
    label: "Any two tabs on the same site are the same page",
    example: ["mail.example.com/inbox", "mail.example.com/sent"],
    note: "Meant for webmail and admin consoles. Set it per site rather than here."
  },
  {
    field: "samePathPrefix",
    label: "Same site and the first {N} parts of the path",
    example: ["example.com/issues/12", "example.com/issues/34"],
    // R10's N, written into the middle of the sentence the way the mockup has it.
    number: { field: "pathPrefixSegments", label: "How many parts of the path to compare", min: 1, max: 8 }
  }
];

// The key pieces explainDifference can name, as the clause the verdict reads them out in. The
// verdict says what differs before it says which switch would match them, because what differs is
// the fact and the switch is the advice.
const PIECE_PHRASES = {
  scheme: "the schemes differ",
  host: "the sites differ",
  port: "the ports differ",
  path: "the paths differ",
  query: "the parameters differ",
  fragment: "the parts after # differ"
};

// The two verdict marks. Constant markup, so this is the one place innerHTML is used and nothing
// the user typed ever reaches it.
const MARK = {
  same:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle>' +
    '<path d="M8 12.4l2.6 2.6L16 9.6"></path></svg>',
  diff:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle>' +
    '<path d="M15 9l-6 6M9 9l6 6"></path></svg>'
};

// The settings object the page is showing. It is the authority while the page is open: a write that
// fails leaves it in place so the session keeps working [TSD Error Handling].
let settings = null;
// The host whose per-site editor is open: a host string, "" for a new entry, null for no editor.
let editingHost = null;

const $ = (id) => document.getElementById(id);

// Build one element. Text is set as a text node, never as markup.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// A real button, typed so it can sit inside the tester's form without submitting it.
function button(className, text, onClick) {
  const node = el("button", className, text);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

// "1 tab" / "3 tabs". Counts are read out loud in confirmations, so they have to read correctly.
function count(n, word) {
  return n + " " + word + (n === 1 ? "" : "s");
}

// A stored addedAt shown the way the mockup shows it, "4 Sep". The time is appended so the date is
// read in the local zone rather than UTC, which would slip a day west of Greenwich.
function shortDate(iso) {
  const when = new Date(String(iso) + "T00:00:00");
  if (Number.isNaN(when.getTime())) return String(iso);
  return when.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

// The rule's sentence with R10's segment count written into it.
function ruleLabel(meta, rules) {
  const n = rules && rules.pathPrefixSegments ? rules.pathPrefixSegments : DEFAULTS.rules.pathPrefixSegments;
  return meta.label.replace("{N}", String(n));
}

// The page's one message line: a failed write, a rejected entry, or the result of a sweep. An error
// stays until something replaces it; an ordinary note clears itself, so it cannot be mistaken for a
// standing problem.
let statusTimer = 0;
function showStatus(text, bad) {
  const node = $("status");
  node.textContent = text;
  node.className = bad ? "status bad" : "status";
  node.hidden = false;
  clearTimeout(statusTimer);
  if (!bad) statusTimer = setTimeout(() => { node.hidden = true; }, 6000);
}

// Adopt a new settings object and write it. The page is updated from the new values first, so the
// change is in effect whether or not the write lands; a write that fails says so and the values
// stay live for the session rather than being silently dropped [TSD Error Handling].
async function persist(next) {
  settings = next;
  render();
  const result = await saveSettings(next);
  if (!result.ok) {
    showStatus("DejaTab could not save that change: " + result.error +
      ". It is in effect until you close Chrome, but it was not stored.", true);
  }
}

// A change to some of the global rule fields, leaving the rest as they are.
function patchRules(partial) {
  return { ...settings, rules: { ...settings.rules, ...partial } };
}

// Build the ten rule rows once. The switches are then only ever updated in place, which is what
// lets a user type in R6's field without the row being rebuilt under the cursor.
function buildRules() {
  const box = $("rules");
  for (const meta of RULE_META) {
    const row = el("div", "rule");
    const id = "rule-" + meta.field;

    // The switch is a real checkbox, so it is still a checkbox to the keyboard and to a reader.
    const sw = el("input", "sw");
    sw.type = "checkbox";
    sw.id = id;
    sw.addEventListener("change", () => persist(patchRules({ [meta.field]: sw.checked })));

    const body = el("div", "rule-body");
    const name = el("span", "rule-name");

    if (meta.number) {
      // R10's sentence has the count in the middle of it. Two labels for one control is legal and
      // keeps the whole sentence clickable, and the number gets a label of its own.
      const [before, after] = meta.label.split("{N}");
      name.append(labelFor(id, before.trim() + " "));
      const field = el("input", "fld");
      field.type = "number";
      field.id = "rule-" + meta.number.field;
      field.min = String(meta.number.min);
      field.max = String(meta.number.max);
      field.step = "1";
      field.setAttribute("aria-label", meta.number.label);
      field.addEventListener("change", () => {
        // R10's 1 to 8 range lives in settings.js. The page's only job is to say when a typed count
        // was moved, so the user is not left thinking the number they typed was stored.
        const n = normalizeSegments(field.value);
        if (String(n) !== field.value.trim()) {
          showStatus("The path can be compared 1 to 8 parts deep. DejaTab used " + n + ".");
        }
        persist(patchRules({ pathPrefixSegments: n }));
      });
      name.append(field, labelFor(id, " " + after.trim()));
    } else {
      name.append(labelFor(id, meta.label));
    }
    body.append(name);

    // The example pair, so the rule can be understood without experimenting on real tabs.
    if (meta.example) {
      const example = el("span", "rule-example");
      example.append(el("span", "u", meta.example[0]), el("span", "eq", " = "), el("span", "u", meta.example[1]));
      body.append(example);
    }
    if (meta.desc) body.append(el("span", "rule-desc", meta.desc));
    if (meta.note) body.append(el("span", "rule-note", meta.note));

    // R6's list of parameter names. Committed on change rather than on every keystroke, so a
    // half-typed name is never stored and the write rate stays where the user's typing is.
    if (meta.text) {
      const label = el("label", "sr-only", meta.text.label);
      label.htmlFor = "rule-" + meta.text.field;
      const field = el("input", "fld mono");
      field.type = "text";
      field.id = "rule-" + meta.text.field;
      field.placeholder = meta.text.placeholder;
      field.addEventListener("change", () => {
        persist(patchRules({ [meta.text.field]: normalizeParamNames(field.value) }));
      });
      body.append(label, field);
    }

    row.append(sw, body);
    box.append(row);
  }
}

// A label bound to a control by id.
function labelFor(id, text) {
  const label = el("label", "", text);
  label.htmlFor = id;
  return label;
}

// Build the tracking parameter grid once, from rules.js's own list. A ticked box means the
// parameter is dropped; only the names that are switched off are stored, in trackingParamsOff.
function buildTracking() {
  const box = $("tracking");
  for (const name of TRACKING_PARAMS) {
    const row = el("div", "check");
    const cb = el("input", "cb");
    cb.type = "checkbox";
    cb.id = "tp-" + name;
    cb.addEventListener("change", () => {
      const off = TRACKING_PARAMS.filter((each) => !$("tp-" + each).checked);
      persist(patchRules({ trackingParamsOff: off }));
    });
    const label = labelFor("tp-" + name, name);
    label.className = "mono";
    row.append(cb, label);
    box.append(row);
  }
}

// Push the stored values into the controls, and rebuild the three lists. Called after every change,
// whether it was made here or arrived from a banner's Always or Never.
function render() {
  const rules = settings.rules;
  for (const meta of RULE_META) {
    $("rule-" + meta.field).checked = rules[meta.field] === true;
    if (meta.number) $("rule-" + meta.number.field).value = String(rules[meta.number.field]);
    if (meta.text) $("rule-" + meta.text.field).value = (rules[meta.text.field] || []).join(", ");
  }
  for (const name of TRACKING_PARAMS) $("tp-" + name).checked = !rules.trackingParamsOff.includes(name);
  $("timeout").value = String(settings.bannerTimeoutSeconds);
  renderMode();
  for (const field of Object.keys(HOST_LISTS)) renderHosts(field);
  renderSites();
}

// The mode control and its two dependent lines [allow-list FR-3, FR-8, FR-18]. The radios are set
// from settings on every render, so a change made in another options tab shows up here.
function renderMode() {
  const listed = settings.allowListOnly === true;
  $("mode-all").checked = !listed;
  $("mode-listed").checked = listed;
  // An empty allow-list in "Only listed sites" mode means DejaTab does nothing, which must not be
  // a surprise [allow-list FR-18].
  $("mode-notice").hidden = !(listed && settings.allowedHosts.length === 0);
  // The allow-list stays editable in "All sites" mode, but says it is inert there [allow-list FR-8].
  $("allowed-inert").hidden = listed;
  // And looks it: the card is greyed out while the switch is on every site, and only then [allow-list FR-17].
  $("allowed-card").classList.toggle("inert", !listed);
}

// The two host lists, keyed by their settings field. Both share one entry shape, so one renderer and
// one add handler serve both, and only the words differ [TSD Allowed sites list]. `id` is the list
// container, and the add field and its button are id "add-" + id and "add-" + id + "-go".
const HOST_LISTS = {
  // The exclusion list [FR-14]. The origin label is the entry's source field: an entry the user
  // typed against one a Never answer wrote [FR-8].
  excludedHosts: {
    id: "excluded",
    empty: "No sites are excluded. DejaTab looks at every site.",
    origin: (entry) => (entry.source === "never" ? "added by Never" : "added by you"),
    removeLabel: "Stop excluding ",
    already: " is already excluded."
  },
  // The allow-list [allow-list FR-6, FR-7]. Every entry is typed here, so there is no source to name.
  allowedHosts: {
    id: "allowed",
    empty: "No sites are allowed yet.",
    origin: () => "added",
    removeLabel: "Stop allowing ",
    already: " is already allowed."
  }
};

// One host list: a row per entry with its origin, date and a Remove button, or the empty line.
function renderHosts(field) {
  const words = HOST_LISTS[field];
  const box = $(words.id);
  box.textContent = "";
  if (settings[field].length === 0) {
    box.append(el("p", "empty", words.empty));
    return;
  }
  for (const entry of settings[field]) {
    const row = el("div", "row");
    row.append(el("span", "host", entry.host));
    const origin = words.origin(entry);
    row.append(el("span", "origin", entry.addedAt ? origin + " on " + shortDate(entry.addedAt) : origin));
    const remove = button("btn-link", "Remove", () => {
      persist({ ...settings, [field]: settings[field].filter((each) => each.host !== entry.host) });
    });
    remove.setAttribute("aria-label", words.removeLabel + entry.host);
    row.append(remove);
    box.append(row);
  }
}

// What a per-site entry actually changes, as one chip per overridden field [FR-17, FR-18]. Only the
// fields the entry names appear; everything else is inherited and the last chip says so.
function siteChips(entry) {
  const rules = entry.rules || {};
  const chips = [];
  for (const meta of RULE_META) {
    if (!(meta.field in rules)) continue;
    const on = rules[meta.field] === true;
    chips.push({ text: ruleLabel(meta, rules) + ": " + (on ? "on" : "off"), kind: on ? "chip-on" : "chip-off" });
  }
  if (rules.userParams && rules.userParams.length) {
    chips.push({ text: "Parameters dropped here: " + rules.userParams.join(", "), kind: "chip-on" });
  }
  if (rules.trackingParamsOff && rules.trackingParamsOff.length) {
    chips.push({ text: "Tracking parameters kept here: " + rules.trackingParamsOff.join(", "), kind: "chip-off" });
  }
  chips.push({ text: chips.length ? "everything else inherited" : "every rule inherited", kind: "" });
  return chips;
}

// The per-site entries [FR-17, FR-21]: what each one overrides, its close-without-asking flag with
// the origin and date behind it, and the two actions on it.
function renderSites() {
  const box = $("sites");
  box.textContent = "";
  for (const [index, entry] of settings.sites.entries()) {
    const card = el("div", "card site");
    const main = el("div", "site-main");
    main.append(el("span", "site-host", entry.host));

    const chips = el("div", "chips");
    for (const chip of siteChips(entry)) chips.append(el("span", "chip " + chip.kind, chip.text));
    main.append(chips);

    // The flag the Always answer sets, editable here like any other setting [FR-8].
    const auto = el("div", "site-auto");
    const cb = el("input", "cb");
    cb.type = "checkbox";
    cb.id = "site-auto-" + index;
    cb.checked = entry.autoClose === true;
    cb.addEventListener("change", () => {
      persist({
        ...settings,
        sites: settings.sites.map((each) =>
          each.host === entry.host ? { ...each, autoClose: cb.checked } : each)
      });
    });
    auto.append(cb, labelFor(cb.id, "Close duplicates without asking"));
    const origin = entry.source === "always" ? "set by Always" : "added by you";
    auto.append(el("span", "origin", entry.addedAt ? origin + " on " + shortDate(entry.addedAt) : origin));
    main.append(auto);

    const actions = el("div", "site-actions");
    const edit = button("btn-link", "Edit", () => openEditor(entry.host));
    edit.setAttribute("aria-label", "Edit the rules for " + entry.host);
    const remove = button("btn-link", "Remove", () => {
      if (editingHost === entry.host) closeEditor();
      persist({ ...settings, sites: settings.sites.filter((each) => each.host !== entry.host) });
    });
    remove.setAttribute("aria-label", "Remove the entry for " + entry.host);
    actions.append(edit, remove);

    card.append(main, actions);
    box.append(card);
  }
}

// The editor for one per-site entry. Each rule is Inherit, On or Off, because a per-site entry
// overrides only the fields it names and must be able to say nothing about the rest [FR-18].
// It lives in its own container so that a render, including one caused by a banner's answer
// arriving, cannot rebuild it while it is being filled in.
function openEditor(host) {
  editingHost = host;
  const entry = settings.sites.find((each) => each.host === host) || null;
  const rules = (entry && entry.rules) || {};
  const box = $("site-editor");
  box.textContent = "";
  box.hidden = false;

  const card = el("div", "card editor");
  card.append(el("h3", "editor-title", entry ? "Rules for " + entry.host : "Add a site"));

  const hostRow = el("div", "field-row");
  const hostField = el("input", "fld mono grow");
  hostField.type = "text";
  hostField.id = "ed-host";
  hostField.placeholder = "example.com";
  hostField.value = entry ? entry.host : "";
  hostRow.append(labelFor("ed-host", "Site"), hostField);
  card.append(hostRow);
  card.append(el("p", "hint", "The entry covers this site and everything under it. A rule left on " +
    "Inherit keeps the value from the rules above."));

  const grid = el("div", "editor-grid");
  for (const meta of RULE_META) {
    const id = "ed-" + meta.field;
    const select = el("select", "fld");
    select.id = id;
    for (const [value, text] of [["", "Inherit"], ["on", "On"], ["off", "Off"]]) {
      const option = el("option", "", text);
      option.value = value;
      select.append(option);
    }
    select.value = meta.field in rules ? (rules[meta.field] ? "on" : "off") : "";
    grid.append(labelFor(id, meta.label.replace("{N}", "N")), select);
  }
  card.append(grid);

  // The three rule fields that are not a switch: R10's count, R6's names, and the built-in
  // tracking names this site keeps. Each is left out of the stored entry when it is empty, so an
  // untouched field means inherited here too.
  card.append(editorField("ed-pathPrefixSegments", "How many parts of the path to compare (R10)",
    "number", rules.pathPrefixSegments === undefined ? "" : String(rules.pathPrefixSegments)));
  card.append(editorField("ed-userParams", "Parameters to drop on this site", "text",
    (rules.userParams || []).join(", ")));
  card.append(editorField("ed-trackingParamsOff", "Tracking parameters to keep on this site", "text",
    (rules.trackingParamsOff || []).join(", ")));

  const auto = el("div", "site-auto");
  const cb = el("input", "cb");
  cb.type = "checkbox";
  cb.id = "ed-autoClose";
  cb.checked = entry ? entry.autoClose === true : false;
  auto.append(cb, labelFor(cb.id, "Close duplicates without asking"));
  card.append(auto);

  const actions = el("div", "editor-actions");
  actions.append(button("btn btn-primary", "Save", saveEditor), button("btn btn-quiet", "Cancel", closeEditor));
  card.append(actions);

  box.append(card);
  hostField.focus();
}

// One labelled field in the editor.
function editorField(id, label, type, value) {
  const row = el("div", "field-row");
  const field = el("input", type === "text" ? "fld mono grow" : "fld");
  field.type = type;
  field.id = id;
  field.value = value;
  if (type === "number") {
    field.min = "1";
    field.max = "8";
    field.step = "1";
    field.placeholder = "inherit";
  }
  row.append(labelFor(id, label), field);
  return row;
}

function closeEditor() {
  editingHost = null;
  const box = $("site-editor");
  box.textContent = "";
  box.hidden = true;
}

// Write the editor's entry. Only the rules the editor names are stored, and an entry keeps the
// source and date it already had, so editing what an Always wrote does not rewrite its history.
function saveEditor() {
  const typed = $("ed-host").value;
  const host = normalizeHost(typed);
  if (!host) {
    showStatus('"' + typed.trim() + '" is not a site DejaTab can use. Type a site such as example.com.', true);
    return;
  }
  const existing = editingHost ? settings.sites.find((each) => each.host === editingHost) : null;
  // Renaming an entry onto a host that already has one would leave two entries for it, and
  // resolveRules would then pick whichever came first. Refuse instead of guessing.
  if (settings.sites.some((each) => each.host === host && each !== existing)) {
    showStatus("There is already an entry for " + host + ". Edit that one instead.", true);
    return;
  }

  const rules = {};
  for (const meta of RULE_META) {
    const value = $("ed-" + meta.field).value;
    if (value) rules[meta.field] = value === "on";
  }
  // R10's count only means something alongside R10 itself, so it is stored only when R10 is named.
  if ("samePathPrefix" in rules) rules.pathPrefixSegments = normalizeSegments($("ed-pathPrefixSegments").value);
  const userParams = normalizeParamNames($("ed-userParams").value);
  if (userParams.length) rules.userParams = userParams;
  const trackingOff = normalizeParamNames($("ed-trackingParamsOff").value);
  if (trackingOff.length) rules.trackingParamsOff = trackingOff;

  const entry = {
    host,
    rules,
    autoClose: $("ed-autoClose").checked,
    source: existing && existing.source ? existing.source : "user",
    addedAt: existing && existing.addedAt ? existing.addedAt : today()
  };
  const sites = existing
    ? settings.sites.map((each) => (each === existing ? entry : each))
    : [...settings.sites, entry];
  closeEditor();
  persist({ ...settings, sites });
}

// The address tester [FR-24]. The rules are the ones that apply to the first address's host,
// per-site entry included, so the answer is what the extension would actually do rather than what
// the global rules alone would say.
function runTester() {
  const a = $("test-a").value.trim();
  const b = $("test-b").value.trim();
  const verdict = $("verdict");
  const keys = $("keys");
  verdict.textContent = "";
  keys.textContent = "";
  keys.hidden = true;
  if (!a || !b) {
    verdict.append(el("span", "said", "Type an address in both fields."));
    return;
  }

  // An address that will not parse has no host, which simply means the global rules are used and
  // explainDifference reports the address itself as the problem.
  const hostA = hostOf(a);
  const { rules } = resolveRules(hostA, settings);
  const answer = explainDifference(a, b, rules);

  if (answer.invalid) {
    verdict.append(mark("diff"), el("span", "", "Address " + answer.invalid.toUpperCase() +
      " is not an address DejaTab can read. Include the scheme, as in https://example.com/page."));
    return;
  }

  // A site DejaTab does not act on is inert in both directions: it is never closed and never asks
  // [FR-15, allow-list FR-10]. So a same-or-different answer about its addresses would be true of the
  // rules and false of what the extension would do, which is the one thing this tester exists to
  // answer. Naming that site is the whole answer for the pair, whichever side of it is inert.
  const inert = inertHosts([hostA, hostOf(b)]);
  if (inert.length) {
    const line = el("span", "");
    line.append(el("strong", "", "Nothing would happen. "));
    line.append(el("span", "said", inertSentence(inert)));
    verdict.append(mark("diff"), line);
    return;
  }
  if (answer.same) {
    verdict.append(mark("same"), el("span", "", "The same page."));
    keys.append(el("span", "", "After your rules run, both addresses are "), el("span", "u", answer.key));
    keys.hidden = false;
    return;
  }

  // Different pages: what actually differs first, then the narrowest switch that would match them.
  // The two clauses are independent, because explainDifference reports a piece for every mismatch
  // and a rule only when one switch would close the gap.
  const line = el("span", "");
  const phrase = PIECE_PHRASES[answer.piece];
  line.append(el("strong", "", phrase ? "Different pages: " + phrase + ". " : "Different pages. "));
  if (answer.rule) {
    // The rule's plain sentence is what the user has to go and flip, so the field name is only a
    // fallback for a switch this page's table has not been told about.
    const meta = RULE_META.find((each) => each.field === answer.rule);
    line.append(el("span", "said", "The only rule that would match them is "),
      el("strong", "", meta ? ruleLabel(meta, rules) : answer.rule), el("span", "said", "."));
  } else {
    line.append(el("span", "said", "No single rule would match them."));
  }
  verdict.append(mark("diff"), line);
  keys.append(el("span", "", "After your rules run: "), el("span", "u", canonicalKey(a, rules)),
    el("span", "", " against "), el("span", "u", canonicalKey(b, rules)));
  keys.hidden = false;
}

// The two reasons DejaTab leaves a host alone, in the order they are checked, each with the words
// that name it and the change that would undo it [allow-list FR-19].
const INERT_WORDS = {
  excluded: { one: " is an excluded site", many: " are excluded sites", fix: "remove {} from Excluded sites" },
  "not allowed": { one: " is not an allowed site", many: " are not allowed sites", fix: "add {} under Allowed sites" }
};

// Each distinct host DejaTab would leave alone, with its reason. Exclusion comes first because it
// wins in both modes; "not allowed" applies only while the mode is on. A host both addresses share
// is named once, and an address with no host has no reason, as before the allow-list existed.
function inertHosts(hosts) {
  const found = [];
  for (const host of new Set(hosts)) {
    if (!host) continue;
    let reason = "";
    if (isExcluded(host, settings)) reason = "excluded";
    else if (settings.allowListOnly === true && !isAllowed(host, settings)) reason = "not allowed";
    if (reason) found.push({ host, reason });
  }
  return found;
}

// The verdict's sentence for inert hosts: one clause per reason, then the list to change. With one
// reason the fix says "it" or "them"; with two, each fix names its own host so the two do not blur.
// With only excluded hosts the words are exactly those the tester used before the allow-list.
function inertSentence(inert) {
  const pronoun = inert.length > 1 ? "them" : "it";
  const groups = [];
  for (const reason of Object.keys(INERT_WORDS)) {
    const hosts = inert.filter((each) => each.reason === reason).map((each) => each.host);
    if (hosts.length) groups.push({ words: INERT_WORDS[reason], hosts });
  }
  const clauses = groups.map((g) => g.hosts.join(" and ") + (g.hosts.length > 1 ? g.words.many : g.words.one));
  const fixes = groups.map((g) => g.words.fix.replace("{}", groups.length > 1 ? g.hosts.join(" and ") : pronoun));
  const fix = fixes.join(" and ");
  return clauses.join(" and ") + ", so DejaTab ignores " + pronoun + " entirely: it closes no tabs there and " +
    "never asks. " + fix[0].toUpperCase() + fix.slice(1) + " above to test these rules against " + pronoun + ".";
}

// One of the two verdict marks.
function mark(kind) {
  const node = el("span", "verdict-mark " + kind);
  node.innerHTML = MARK[kind];
  return node;
}

// Ask on this page, with the two buttons the question deserves. There is no banner here and no
// Always or Never: a sweep spans many hosts, so neither answer would mean anything [FR-25].
function askConfirm(question, confirmLabel) {
  return new Promise((resolve) => {
    const box = $("confirm");
    box.textContent = "";
    box.hidden = false;
    const finish = (answer) => {
      box.textContent = "";
      box.hidden = true;
      resolve(answer);
    };
    const yes = button("btn btn-primary", confirmLabel, () => finish(true));
    box.append(el("p", "confirm-text", question), yes, button("btn btn-quiet", "Cancel", () => finish(false)));
    yes.focus();
  });
}

// Talk to the service worker. A worker that is not there, an error inside it, and a refusal are all
// reported here rather than swallowed: the user pressed a button and is owed an answer.
//
// Only a reply that says ok is a reply. Every worker handler answers { ok: false, error } when it
// refuses, which is what a stale or already-used cleanup token gets, and such a reply carries no
// count at all. Reading one anyway is how "Closed undefined tabs." would be printed over a sweep
// that closed nothing, so the counts are unreachable unless ok is true.
async function send(message) {
  let reply;
  try {
    reply = await chrome.runtime.sendMessage(message);
  } catch (error) {
    showStatus("DejaTab could not reach the extension: " + (error && error.message ? error.message : error) +
      ". Nothing was closed.", true);
    return null;
  }
  if (!reply || reply.ok !== true) {
    // The worker's own words, verbatim: it knows why it refused and this page does not.
    showStatus(reply && reply.error ? reply.error : "The extension did not answer. Nothing was closed.", true);
    return null;
  }
  return reply;
}

// "Clean up open tabs now" [FR-25]. The worker counts, this page asks once for the whole sweep with
// the totals in the question, and only an agreement sends the token back to close anything.
async function cleanupNow() {
  const found = await send({ type: "dejatab/cleanup" });
  if (!found) return;
  if (!found.tabs) {
    showStatus("No duplicates are open. Nothing to close.");
    return;
  }
  const question = "Close " + count(found.tabs, "tab") + " across " + count(found.groups, "page") + "?";
  if (!await askConfirm(question, "Close " + count(found.tabs, "tab"))) return;
  // The token is single use, so a refusal here ends the attempt: send has already said why, and
  // offering the sweep again from a count the worker has thrown away would ask the user to agree to
  // a number that no longer means anything. The next attempt counts the duplicates afresh.
  const done = await send({ type: "dejatab/cleanup-go", token: found.token });
  if (!done) return;
  showStatus("Closed " + count(done.closed, "tab") + ".");
}

// "Reset to defaults" [FR-27, allow-list FR-20]. Every rule, all three lists, the mode and the timeout
// go back to their shipped values, which clears the allowed sites and the hosts an Always and a Never
// recorded along with everything else.
async function resetAll() {
  const question = "Reset every rule, all three lists and the prompt timeout to their shipped values? " +
    "The allowed sites and the sites recorded by Always and by Never are cleared too.";
  if (!await askConfirm(question, "Reset everything")) return;
  closeEditor();
  // DEFAULTS is frozen, so the page writes and then edits a deep copy of it.
  await persist(JSON.parse(JSON.stringify(DEFAULTS)));
  showStatus("Every setting is back to its shipped value.");
}

// Bind the controls that are in options.html rather than built here.
function bind() {
  $("timeout").addEventListener("change", () => {
    const field = $("timeout");
    const typed = field.value.trim();
    const seconds = normalizeTimeout(typed);
    // normalizeTimeout pulls a typed number into the allowed 0, or 5 to 600. Say so when it did,
    // because a silently corrected number looks like the page ignored the user.
    if (typed !== "" && String(seconds) !== typed) {
      showStatus("The prompt can wait 5 to 600 seconds, or 0 to wait indefinitely. DejaTab used " +
        seconds + ".");
    }
    persist({ ...settings, bannerTimeoutSeconds: seconds });
  });

  // Either radio writes the mode; which one is checked is the whole value [allow-list FR-16].
  for (const id of ["mode-all", "mode-listed"]) {
    $(id).addEventListener("change", () => persist({ ...settings, allowListOnly: $("mode-listed").checked }));
  }

  for (const [listField, words] of Object.entries(HOST_LISTS)) {
    const addHost = () => {
      const field = $("add-" + words.id);
      const typed = field.value;
      const host = normalizeHost(typed);
      if (!host) {
        showStatus('"' + typed.trim() + '" is not a site DejaTab can use. Type a site such as example.com.', true);
        return;
      }
      if (settings[listField].some((each) => each.host === host)) {
        showStatus(host + words.already);
        field.value = "";
        return;
      }
      field.value = "";
      // Typed here, so the source is always "user" in both lists.
      persist({ ...settings, [listField]: [...settings[listField], { host, source: "user", addedAt: today() }] });
    };
    $("add-" + words.id + "-go").addEventListener("click", addHost);
    // Enter in the field does what the button does, since a list is filled in one entry at a time.
    $("add-" + words.id).addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        addHost();
      }
    });
  }

  $("add-site").addEventListener("click", () => openEditor(""));
  // A form so Enter in either address field compares, rather than only the button doing it.
  $("tester").addEventListener("submit", (event) => {
    event.preventDefault();
    runTester();
  });
  $("cleanup").addEventListener("click", cleanupNow);
  $("reset").addEventListener("click", resetAll);
}

async function init() {
  $("version").textContent = "Version " + chrome.runtime.getManifest().version;
  buildRules();
  buildTracking();
  // An Always or a Never answered in a banner is an ordinary settings write, so the page picks it
  // up here and shows it while it is open [FR-8, TSD Messages]. A change this page made comes back
  // through the same event, and re-rendering identical values would only disturb what the user is
  // doing, so an unchanged object is ignored.
  //
  // Registered before the first read rather than after it: a write landing while that read is in
  // flight would otherwise fall into the gap between the read finishing and the listener existing,
  // and never be shown at all. The rows are already built above, so an event arriving this early
  // has everything it needs to render.
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "sync") return;
    const fresh = await loadSettings();
    if (JSON.stringify(fresh) === JSON.stringify(settings)) return;
    settings = fresh;
    render();
  });

  const initial = await loadSettings();
  // A write the listener already picked up is newer than this read, which was issued before it, so
  // the first read gives way rather than writing a stale object over it.
  if (!settings) {
    settings = initial;
    render();
  }
  bind();
}

init();
