// DejaTab's prompt banner.
//
// The one export in this file is never called here. It is handed to
// chrome.scripting.executeScript as its `func`, which serialises the function
// to source text and runs that text inside the tab that just navigated.
// Serialisation is the reason the file looks the way it does: the injected copy
// has no module scope around it, so it can import nothing, name no constant
// declared outside itself and close over no variable. Everything it needs
// arrives in the arguments the worker passes. A helper lifted out of the
// function for tidiness would simply be undefined once injected, which is why
// there is exactly one function here and every helper lives inside it.
//
// The banner never reads the page. It looks up one element, the host element a
// previous question left behind, by the id it set itself. There is no other DOM
// query, no text extraction and nothing sent anywhere but the worker. That is
// the promise FR-13 makes, and it is kept here rather than only in the store
// listing.

/**
 * Asks whether the duplicate tabs should close, in the tab that just navigated.
 *
 * @param {string} promptId Returned with the answer so the worker can tell this
 *   question from a later one and discard a stale banner's answer.
 * @param {{count: number, pageLabel: string, host: string, timeoutSeconds: number}} info
 *   Everything the banner shows: how many other tabs matched, the abbreviated
 *   address, the host an Always or Never would apply to, and the seconds to wait
 *   before giving up, where 0 means wait indefinitely.
 */
export function showBanner(promptId, info) {
  // The id is both how the banner is found again and how a second copy is
  // prevented. It is declared inside the function because nothing outside the
  // function exists once this code is injected.
  const HOST_ID = "dejatab-banner-host";

  // A tab must never show two banners at once, so an earlier question's banner
  // goes before this one is built. This is the only element the script ever
  // looks for, and it is one the script itself created.
  const previous = document.getElementById(HOST_ID);
  if (previous) previous.remove();

  // One host element carrying a closed shadow root. Closed means page scripts
  // cannot reach it through element.shadowRoot, so no site can read the banner,
  // restyle it or click its buttons, and page CSS cannot leak in either. The
  // host's own placement is set inline and marked important, because that one
  // element is the only part of the banner the page's stylesheets can see.
  const host = document.createElement("div");
  host.id = HOST_ID;
  const placement = {
    all: "initial",           // first, so inherited page styles stop at the host
    position: "fixed",        // above the page content, not part of its flow
    top: "0",
    left: "0",
    right: "0",
    "z-index": "2147483647",  // the largest 32-bit z-index, above any site's layers
    "pointer-events": "auto"  // clickable even on a page that disabled pointers
  };
  for (const [property, value] of Object.entries(placement)) {
    host.style.setProperty(property, value, "important");
  }
  const root = host.attachShadow({ mode: "closed" });

  // All styling lives inside the shadow root, where the page cannot reach it.
  // One opaque palette rather than a light and a dark variant: the banner
  // brings its own background, so whether the site under it is light or dark
  // cannot affect the contrast of the text on top.
  const style = document.createElement("style");
  style.textContent = [
    ":host { display: block; }",
    ".bar {",
    "  box-sizing: border-box;",
    "  display: flex; flex-wrap: wrap; align-items: center; justify-content: center;",
    "  gap: 10px; padding: 10px 16px;",
    "  font: 14px/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;",
    "  background: #111827; color: #F9FAFB;",
    "  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.45);",
    "  opacity: 1; transition: opacity 200ms linear;",
    "}",
    ".bar.leaving { opacity: 0; }",
    ".question { font-weight: 600; }",
    ".label {",
    "  color: #9CA3AF; max-width: 46ch;",
    "  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;",
    "}",
    ".group { display: flex; gap: 8px; }",
    // Always and Never are set apart because they change settings rather than
    // answering this one question.
    ".group.settings { margin-left: 10px; padding-left: 18px; border-left: 1px solid #374151; }",
    "button {",
    "  font: inherit; padding: 5px 14px; cursor: pointer;",
    "  border: 1px solid #4B5563; border-radius: 4px;",
    "  background: #1F2937; color: #F9FAFB;",
    "}",
    "button:hover { background: #374151; }",
    "button:focus-visible { outline: 2px solid #93C5FD; outline-offset: 2px; }",
    ".primary { background: #2563EB; border-color: #2563EB; }",
    ".primary:hover { background: #1D4ED8; }"
  ].join("\n");

  const bar = document.createElement("div");
  bar.className = "bar";
  // A real dialog role and a label, so a screen reader announces the question
  // rather than four unexplained buttons.
  bar.setAttribute("role", "alertdialog");
  bar.setAttribute("aria-label", "DejaTab duplicate tab prompt");

  // The question in the user's own words, and the abbreviated address under it
  // so a long URL cannot overflow the bar.
  const question = document.createElement("span");
  question.className = "question";
  question.textContent = info.count === 1
    ? "DejaTab found 1 other tab on this page. Close it?"
    : "DejaTab found " + info.count + " other tabs on this page. Close them?";
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = info.pageLabel;

  let timer = null;  // the one timer the banner ever holds
  let done = false;  // set by the first answer, so a second click does nothing

  const onKeyDown = function (event) {
    // Dismissing without choosing is No: an unanswered question is not
    // permission to close anything [FR-9].
    //
    // It goes through accept so that every answer takes one path, not because
    // the checks add anything here: an untrusted Escape is answered No, which is
    // exactly what a trusted one does, so a page can dismiss its own prompt this
    // way. The tolerated cases above say why that is the trade and not a hole.
    if (event.key === "Escape") accept("no", event);
  };

  const expire = function () {
    timer = null;
    // A brief fade so the banner does not vanish mid-glance, then the same
    // answer a dismissal gives. The removal rides on a second short timeout
    // rather than the transition's end event, because a page or profile with
    // transitions disabled would never fire that event and the question would
    // hang on screen with no answer ever sent.
    bar.classList.add("leaving");
    setTimeout(function () { finish("no"); }, 220);
  };

  const stopTimer = function () {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const startTimer = function () {
    // A timeout of 0 means wait indefinitely, so no timer is created at all.
    if (done || !(info.timeoutSeconds > 0)) return;
    timer = setTimeout(expire, info.timeoutSeconds * 1000);
  };

  const finish = function (answer) {
    if (done) return;
    done = true;
    stopTimer();
    window.removeEventListener("keydown", onKeyDown, true);
    host.remove();
    try {
      // The worker replies with nothing. The banner holds no state and survives
      // no navigation, so it is gone by the time the worker acts.
      //
      // Called with no callback this returns a promise, and a receiving end that
      // has gone away rejects it rather than throwing, so the catch below would
      // never see it and Chrome would log an unhandled rejection in the page's
      // own console. An extension that promises to touch nothing does not leave
      // errors on someone's page, so the rejection is swallowed here. The answer
      // is lost either way, which is the documented outcome: nothing closes.
      const sent = chrome.runtime.sendMessage({ type: "dejatab/answer", promptId: promptId, answer: answer });
      if (sent && typeof sent.catch === "function") sent.catch(function () {});
    } catch (error) {
      // The extension was reloaded while the banner was up, so there is nothing
      // left to report the answer to. The banner is already removed.
    }
  };

  // A closed shadow root seals the tree inside it, not the element it hangs on.
  // The host sits in the page's own light DOM under a known id, so a hostile page
  // owns its placement outright: geometry beats the cascade. A transform, filter,
  // backdrop-filter, contain, perspective or will-change on an ancestor makes
  // that ancestor the containing block for a fixed element and composites this
  // subtree, so the banner resolves against that box instead of the viewport.
  // The inline important declarations above do not prevent that, and nothing in
  // the page can.
  //
  // What can be done is to make a tampered banner's answer worthless, which takes
  // away the choice of where to put the Yes button and leaves the page hoping the
  // user happens to click the top strip of the viewport. That is the whole value
  // of these checks, and it is why they test for gross displacement rather than
  // for exact placement.
  //
  // The thresholds are loose on purpose, and the trade is deliberate. Sites set
  // those same properties honestly, on body, for a drawer, a modal blur or paint
  // containment, and a body capped at 1200px in a 1600px viewport then measures
  // 1200. A tight test would fail there and turn every Yes on that site into a
  // silent No, which the user experiences as "DejaTab asks me and then does
  // nothing here", with nothing in the interface to explain it. That is a worse
  // outcome than the attack, which can only ever reach the attacking site's own
  // tabs. So a bar the page's own layout moved honestly is tolerated, and only a
  // bar moved somewhere it could harvest a click is refused.
  //
  // Two things are tolerated and named so nobody reads these checks as complete.
  // An ancestor filter of opacity(0.01) leaves the geometry untouched and simply
  // makes the banner invisible; a user cannot click what they cannot see, so it
  // costs the page a click it cannot direct.
  //
  // And the ceiling that follows from answering No on a failed check: a page can
  // dismiss its own prompt whenever it likes by dispatching a synthetic Escape on
  // window as it loads, so its duplicates never close. That is a page declining
  // the feature on its own tabs, which is the safe direction, and the
  // alternative, ignoring an untrusted event rather than answering No, parks the
  // question and suppresses prompts in every other tab, which is the worse trade
  // and was rejected.
  const placedByDejaTab = function () {
    // Attached where it was put. The host goes on documentElement rather than
    // body precisely because a containing-block property on body is common while
    // one on html is rare, so this check can be strict without costing real
    // sites. Reparenting into page furniture is the easiest form of the attack.
    if (host.parentNode !== document.documentElement) return false;
    // Gross displacement only: too far down the viewport to be the top bar, too
    // narrow to be a bar at all, or flattened to nothing. Between them these
    // refuse a bar parked next to a video's play button, one scaled away and one
    // clipped away.
    //
    // Deliberately not a check that the click landed inside the button's own
    // rect: a relocated banner carries its rects with it, so that would always
    // pass. The question is where the banner is, not where the pointer was.
    const rect = host.getBoundingClientRect();
    if (rect.top > window.innerHeight * 0.2) return false;
    if (rect.width < window.innerWidth / 3) return false;
    if (rect.height < 12) return false;
    // How much of the bar is actually on screen, which is not the same question
    // as how tall it is. A bar translated above the viewport keeps its full
    // height while showing a few pixels at the top edge, so height alone lets it
    // through; its bottom edge is what gives it away. Expressed against what is
    // visible rather than against an exact position, so a layout that shifts the
    // bar down by a few pixels still passes.
    if (rect.top + rect.height < 12) return false;
    return true;
  };

  // Every answer the user gives passes through here. A click a page dispatched
  // itself is not trusted, and real input always is, so there are no false
  // positives; the window object is shared between the page world and this
  // isolated world, which is how a synthetic Escape would otherwise reach the
  // key handler.
  //
  // A failed check answers No rather than doing nothing. Doing nothing would
  // leave the question parked, and a parked question suppresses prompts
  // everywhere else, which is a reward rather than a defeat. No clears the
  // record, so the same page is asked about again on its next navigation.
  const accept = function (value, event) {
    if (!event || event.isTrusted !== true || !placedByDejaTab()) {
      finish("no");
      return;
    }
    finish(value);
  };

  const makeButton = function (text, answer, primary, hint) {
    // A real button element, every time: focusable, keyboard-operable and
    // announced as a button. A clickable div is none of those things.
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    if (primary) button.className = "primary";
    if (hint) button.title = hint;
    button.addEventListener("click", function (event) { accept(answer, event); });
    return button;
  };

  // Yes and No answer this question and sit together. Always and Never change
  // settings, so they are a separate group.
  const nowGroup = document.createElement("div");
  nowGroup.className = "group";
  const yes = makeButton("Yes", "yes", true, "Close the matching tabs now");
  nowGroup.append(yes, makeButton("No", "no", false, "Keep every tab open"));
  const settingsGroup = document.createElement("div");
  settingsGroup.className = "group settings";
  settingsGroup.append(
    makeButton("Always", "always", false, "Close duplicates on " + info.host + " without asking from now on"),
    makeButton("Never", "never", false, "Ignore " + info.host + " entirely from now on")
  );

  bar.append(question, label, nowGroup, settingsGroup);
  root.append(style, bar);
  // Attached to documentElement, not to body. A fixed element resolves against
  // whichever ancestor establishes a containing block, and body is where sites
  // put a transform or a filter for a drawer or a blur, while html almost never
  // carries one. Hanging off html therefore keeps the banner measuring the
  // viewport on far more sites, which is what lets placedByDejaTab refuse a
  // displaced bar without punishing an honest layout. It also works in a document
  // with no body at all, such as an XML file rendered in a tab.
  document.documentElement.append(host);

  // Yes is focused, so Enter answers the question the banner leads with.
  yes.focus();
  // Capture phase at the window, so a page that swallows key events in its own
  // handlers cannot swallow Escape as well.
  window.addEventListener("keydown", onKeyDown, true);

  // Reading the question must not cost the user the question. Hovering clears
  // the timer and leaving starts the full timeout again, not the remainder.
  host.addEventListener("mouseenter", stopTimer);
  host.addEventListener("mouseleave", startTimer);
  startTimer();
}
