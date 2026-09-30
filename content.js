// Ambxst YTD browser extension.
//
// The button is injected into YouTube's action row. The interesting part is
// the watchdog at the bottom: a watch page mutates constantly (player,
// comments, ads, recommendations) *and* YouTube throws the whole action row
// away every time the video changes, so injection has to be idempotent, cheap,
// and permanently re-armed for as long as a watch page is on screen.
(function () {
  "use strict";

  // The project's own mark. Deliberately NOT YouTube's download arrow: this
  // glyph is the project logo and is what tells the custom button apart from
  // YouTube's own download button.
  const BUTTON_ID = "ambxst-ytd-download-button";
  const READY_CLASS = "ambxst-ytd-ready";
  const THEME_ATTRS = ["darky", "lighty"];

  // Every id the popup uses is namespaced for the same reason the button id is:
  // the popup is attached to the top level of a page we do not control, and a
  // bare "popup-bg" can collide with an element YouTube (or another extension)
  // already owns.
  const POPUP_ID = "ambxst-ytd-popup-bg";
  const FORMAT_NAME = "ambxst-ytd-format";

  // Watchdog timings. The first retry is quick because the action row is almost
  // always already there; the ceiling keeps a page that is still rendering from
  // being polled hundreds of times a second.
  const RETRY_MIN_MS = 120;
  const RETRY_MAX_MS = 1000;
  const POLL_MS = 750;

  // Bounds for a neighbouring button height worth copying. Anything outside is
  // a collapsed or unrendered node rather than a real button.
  const MIN_BUTTON_HEIGHT = 28;
  const MAX_BUTTON_HEIGHT = 64;

  const svgInnerHtml = `
  <svg width="11" height="16" viewBox="0 0 11 16" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M7.58303 12.8232L9.64172 7.97294C10.7817 5.28719 11.3518 3.94433 10.768 3.32838C10.1842 2.71367 8.96505 3.37576 6.52673 4.70116C6.02209 4.97548 5.77092 5.11264 5.50025 5.11264C5.22957 5.11264 4.97727 4.97548 4.47376 4.70116C2.03546 3.37576 0.815145 2.71367 0.232519 3.32962C-0.352403 3.94433 0.218756 5.28719 1.35878 7.97418L3.41747 12.8232C4.31665 14.9404 4.76624 16.0002 5.50025 16.0002C6.23427 16.0002 6.68385 14.9417 7.58303 12.8232Z" fill="currentColor"/>
  <path d="M6.35114 1.32617C8.37107 0.230703 9.38111 -0.316569 9.86481 0.191408C10.171 0.513732 10.0908 1.07571 9.75348 2.00879C8.97942 2.33322 7.99251 2.85492 6.73883 3.51758L6.73102 3.52149C6.12753 3.84051 5.82568 3.99992 5.50055 4C5.17389 4 4.86895 3.83953 4.26129 3.51758C3.00733 2.85477 2.01999 2.33408 1.24567 2.00977C0.908114 1.07637 0.828508 0.514091 1.13532 0.192384C1.61806 -0.316801 2.62964 0.230496 4.64997 1.32617C5.06705 1.55288 5.27632 1.66602 5.50055 1.66602C5.72373 1.6659 5.93094 1.55381 6.34528 1.3291L6.35114 1.32617Z" fill="currentColor"/>
  </svg>
  `;

  function debugLog(...args) {
    console.log("%c[ambxst-ytd]", "color:#3ea6ff;font-weight:bold", ...args);
  }

  // ---------------------------------------------------------------- theme ----

  // Re-evaluated on every navigation because YouTube is a single page app and
  // the user can switch theme without a reload. Comparing against an exact
  // rgb() string breaks as soon as the browser serialises it differently, so
  // the luminance of the resolved colour decides instead.
  //
  // YouTube paints the page background on the document element, but not always
  // (some layouts paint it on ytd-app), so a few candidates are tried. If none
  // of them yields a parseable colour the current theme is kept rather than
  // forced to dark, which would otherwise flicker the button to the wrong
  // colours whenever the stylesheet was not ready yet.
  const THEME_PROBES = ["html", "ytd-app", "#content"];
  let lastThemeIsDark = true;

  function themeIsDark() {
    for (const selector of THEME_PROBES) {
      const node = selector === "html" ? document.documentElement : document.querySelector(selector);
      if (!node) continue;
      const color = window.getComputedStyle(node).backgroundColor || "";
      const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/.exec(color);
      if (!match) continue;
      // A fully transparent background is not black: it means the page is
      // painted by one of the other probes, and reading it as black pinned the
      // button to the dark theme on a light page. The alpha channel was never
      // part of the match, so rgba(0, 0, 0, 0) -- what getComputedStyle
      // returns for an unpainted background -- decided the theme on its own
      // and the remaining probes were never reached.
      if (match[4] !== undefined && Number(match[4]) === 0) continue;
      // 0.2126/0.7152/0.0722 is the Rec. 709 luma weighting; the mid grey of
      // YouTube's two themes is far enough from 128 that a straight average
      // would misclassify the light theme.
      const luminance =
        0.2126 * +match[1] + 0.7152 * +match[2] + 0.0722 * +match[3];
      return luminance < 128;
    }
    return lastThemeIsDark;
  }

  function syncTheme() {
    const root = document.documentElement;
    const isDark = themeIsDark();
    lastThemeIsDark = isDark;
    for (const attr of THEME_ATTRS) root.removeAttribute(attr);
    root.setAttribute(isDark ? "darky" : "lighty", "");
  }

  // --------------------------------------------------------------- layouts ----
  //
  // Where the button goes, what it looks like and which URL a click downloads
  // all depend on which YouTube surface is on screen, so each surface is
  // described once, here. The watchdog stays surface agnostic: it asks
  // activeLayout() for a description and then treats every surface the same way.
  // Adding one is an entry in this table plus its styling in content.css, not
  // another branch in the injection code.
  //
  //   name        used in the debug log
  //   matches()   whether the button belongs on the page at all
  //   containers  candidate parents, best first
  //   anchor      selector for the node the button follows, or null to append
  //   variant     suffix of the .ambxst-ytd-button--* class content.css styles
  //   label       text shown with the mark
  //   hideOwn     whether YouTube's own download button should be hidden
  //   pageUrl()   the URL the download request is built from
  const WATCH_LAYOUT = {
    name: "watch",
    // /clip/ is a trimmed video and carries the same action row. The hostname
    // guard is what keeps music.youtube.com out: it serves /watch URLs too, with
    // a completely different DOM.
    //
    // /shorts/ is still inside this gate because it is what shipped, but its
    // overlay is a different DOM that these containers do not describe, so on a
    // Short this matches and then finds nothing.
    matches() {
      const path = window.location.pathname;
      return (
        window.location.hostname === "www.youtube.com" &&
        (path.startsWith("/watch") ||
          path.startsWith("/clip") ||
          path.startsWith("/shorts/"))
      );
    },
    containers: [
      "ytd-watch-metadata #top-level-buttons-computed",
      "#top-level-buttons-computed",
      "ytd-watch-metadata #actions",
      "#actions",
    ],
    anchor: "segmented-like-dislike-button-view-model",
    variant: "pill",
    label: "Download",
    hideOwn: true,
    // The page URL is the video for this surface; a surface whose player
    // outlives the URL (YT Music) resolves it from the player instead.
    pageUrl: () => window.location.href,
  };

  const LAYOUTS = [WATCH_LAYOUT];

  // The first layout that applies to the page on screen, or null when the button
  // has no business here at all. A layout that throws while matching is skipped
  // rather than allowed to take the watchdog down with it.
  function activeLayout() {
    for (const layout of LAYOUTS) {
      try {
        if (layout.matches()) return layout;
      } catch (error) {
        debugLog(`layout ${layout.name} could not be matched`, error);
      }
    }
    return null;
  }

  // The URL a click should download, as resolved by the surface on screen.
  function currentPageUrl() {
    const layout = activeLayout();
    return layout && layout.pageUrl ? layout.pageUrl() : window.location.href;
  }

  // ------------------------------------------------------------ injection ----

  // Whether the user can actually see a node. This reads layout, so it is kept
  // off the mutation hot path (the observer runs ensureButton) and is only used
  // by the slower checks and by the poll.
  function isRendered(node) {
    if (typeof node.checkVisibility === "function") {
      try {
        // checkVisibilityCSS is what picks up display:none on the node itself or
        // on any ancestor, which is exactly what "YouTube parked this row out of
        // sight" looks like. Opacity is deliberately not part of the test: a row
        // that is fading in is still the row the user is looking at.
        return node.checkVisibility({ checkVisibilityCSS: true });
      } catch (error) {
        // Older engines reject the options bag; the bare call still covers
        // display:none and visibility:hidden.
        try {
          return node.checkVisibility();
        } catch (ignored) {
          /* fall through to the rect test below */
        }
      }
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // One layout's container to inject into. More than one candidate can be on the
  // page at the same time: YouTube keeps an alternate action row around for the
  // compact layout and for player-state swaps, and a row that is no longer the
  // one on screen is useless to us. Every match is therefore considered, and a
  // row that is actually rendered wins over one that is not. When no row is
  // rendered at all YouTube itself is hiding the action area (miniplayer,
  // theater transitions) and the first match is the right answer anyway.
  function findContainer(layout) {
    let first = null;
    for (const selector of layout.containers) {
      for (const node of document.querySelectorAll(selector)) {
        if (first === null) first = node;
        if (isRendered(node)) return node;
      }
    }
    return first;
  }

  // Is the button sitting in a row that is still live? Being connected is not
  // enough: the button survives a layout change that moved the row the user sees
  // somewhere else, and the watchdog would then report success forever while the
  // user looks at an action row with no download button in it.
  //
  // A hidden row only counts as stale when some *other* row is the visible one.
  // When YouTube hides every row the placement is right and the button comes
  // back with the row.
  function placementIsValid(button, layout) {
    let buttonInHiddenRow = false;
    let someRowVisible = false;
    for (const selector of layout.containers) {
      for (const node of document.querySelectorAll(selector)) {
        const rendered = isRendered(node);
        if (node.contains(button)) {
          if (rendered) return true;
          buttonInHiddenRow = true;
        } else if (rendered) {
          someRowVisible = true;
        }
      }
    }
    return buttonInHiddenRow && !someRowVisible;
  }

  // The button is only considered present when it is both findable and still
  // attached to the document. A node that YouTube detached but that is still
  // referenced somewhere (or, more practically, a duplicate left over from a
  // half-finished injection) would otherwise satisfy the presence check and
  // stop the watchdog from re-injecting.
  function existingButton() {
    const button = document.getElementById(BUTTON_ID);
    return button && button.isConnected ? button : null;
  }

  // YouTube's own download button is hidden by a rule in content.css scoped to
  // the ready class, rather than by an inline style. YouTube re-renders its
  // action row and would drop an inline style set earlier, letting the original
  // button reappear next to ours.
  function markReady(on) {
    const root = document.documentElement;
    if (on) root.classList.add(READY_CLASS);
    else root.classList.remove(READY_CLASS);
  }

  function buildButton(layout) {
    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    // The variant class is what content.css styles: the watch page wants the
    // pill with the label beside the mark, Shorts wants a round button with the
    // label underneath. The markup is the same either way.
    button.className = `ambxst-ytd-button ambxst-ytd-button--${layout.variant}`;
    button.innerHTML =
      `${svgInnerHtml}<span class="ambxst-ytd-button-label">${layout.label}</span>`;
    button.setAttribute("aria-label", "Download with Ambxst YTD");
    button.addEventListener("click", onButtonClick);
    return button;
  }

  // YouTube changes its own button metrics periodically, so a hardcoded height
  // drifts out of line and the button reads as too small next to its
  // neighbours. Measure a real sibling button and adopt its height and pill
  // radius instead. The CSS default stays in place if nothing can be measured.
  function matchNeighbourMetrics(button) {
    // Only the pill copies its neighbour's height and radius. A round variant
    // (Shorts, YT Music) is sized by its own rule in content.css, and copying a
    // tall action-row neighbour into it would break the shape. The button
    // carries its own variant, so this needs no extra argument and the resize
    // and theme listeners can call it without knowing which surface is up.
    if (!button.classList.contains("ambxst-ytd-button--pill")) return;
    // Measure around the button itself rather than by searching the document
    // again: the container we were injected into is the only one whose children
    // are comparable buttons.
    const container = button.parentElement;
    if (!container) return;

    let height = 0;
    for (const node of container.children) {
      if (node === button || node.contains(button)) continue;
      const measured = Math.round(node.getBoundingClientRect().height);
      // Ignore collapsed or implausible boxes and keep looking.
      if (measured >= MIN_BUTTON_HEIGHT && measured <= MAX_BUTTON_HEIGHT) {
        height = measured;
        break;
      }
    }
    if (!height) return;

    button.style.height = `${height}px`;
    // A pill shape, matching YouTube's fully rounded action buttons.
    button.style.borderRadius = `${Math.round(height / 2)}px`;
    // Keep the glyph optically proportional to the taller button.
    const glyph = Math.round(Math.min(20, Math.max(14, height * 0.44)));
    button.style.setProperty("--ambxst-glyph-height", `${glyph}px`);
  }

  // Idempotent and cheap: this is the hot path, run on every coalesced mutation
  // batch, so "already there" stays one lookup and "not there" stays one insert.
  // It answers "is our button on the page", not "is it in the right place" --
  // that is verifyButton, which reads layout and is deliberately kept off this
  // path.
  function ensureButton() {
    const layout = activeLayout();
    if (!layout) {
      removeButton();
      return false;
    }
    if (existingButton()) {
      // Re-assert the marker class: it is what hides YouTube's own download
      // button, and a theme change or an unrelated script touching <html> can
      // leave the button present but the class gone.
      markReady(!!layout.hideOwn);
      return true;
    }
    // Nothing of ours on the page. Hand the row back to YouTube's own download
    // button (content.css hides it only while ours is there) so the action row is
    // never left empty, and take it over again as soon as the injection below
    // succeeds. Both happen in this same task, so the swap is never painted.
    markReady(false);
    return injectButton(layout);
  }

  // The slow, thorough check: presence *and* placement. Run on the poll, on
  // navigation, and when the tab comes back to the foreground, where a layout
  // read is affordable and the page state has settled.
  function verifyButton() {
    const layout = activeLayout();
    if (!layout) {
      removeButton();
      return false;
    }
    const button = existingButton();
    if (button) {
      if (placementIsValid(button, layout)) {
        markReady(!!layout.hideOwn);
        return true;
      }
      debugLog(`download button is outside the ${layout.name} container on screen`);
      button.remove();
    }
    markReady(false);
    return injectButton(layout);
  }

  function injectButton(layout) {
    const container = findContainer(layout);
    if (!container) return false;

    // The anchor is the neighbour the button belongs beside -- the like/dislike
    // pair, on the watch page. It is not guaranteed to exist: that is a view
    // model YouTube has renamed before, and other surfaces do not render it at
    // all. Falling back to the end of the container keeps the button injectable
    // instead of failing forever on a missing anchor.
    const anchor = layout.anchor ? container.querySelector(layout.anchor) : null;
    const button = buildButton(layout);
    if (anchor) anchor.insertAdjacentElement("afterend", button);
    else container.appendChild(button);
    matchNeighbourMetrics(button);
    markReady(!!layout.hideOwn);
    debugLog(`injected download button (${layout.name})`);
    return true;
  }

  function removeButton() {
    const button = existingButton();
    if (button) button.remove();
    markReady(false);
    closePopup();
  }

  // ------------------------------------------------------------- watchdog ----
  //
  // A watch page mutates constantly -- player, comments, ads, recommendations
  // -- and YouTube throws the whole action row away every time the video
  // changes. The deterministic version of that bug (an observer that was armed
  // only on the error path, then disarmed on success) is what the current shape
  // fixes: the watchdog is armed for as long as a watch page is on screen and
  // every mechanism funnels into the same idempotent check.
  //
  // Three mechanisms keep the button alive:
  //   * the MutationObserver, which repairs the button in the same task that
  //     YouTube drops it,
  //   * a self-sustaining retry, for a row that appears without producing an
  //     observed mutation,
  //   * a slow poll, as a backstop for a rendering path that mutates nothing
  //     at all, and the only place a button that is present but in the wrong row
  //     gets moved.
  // On top of those, the tab becoming visible again forces a check, because a
  // background tab has its timers throttled and its frames suspended.
  let observer = null; // MutationObserver, armed while a watch page is up
  let retryTimer = null; // backoff retry while the button is missing
  let pollTimer = null; // slow poll, covers mutations that never arrive
  let retryDelay = RETRY_MIN_MS;

  // The watchdog is the only thing keeping the button alive, so no single check
  // may be able to take it down. Anything the page does to us while we are
  // touching its DOM -- a custom element reacting synchronously, a layout read
  // on a node that is being torn down -- surfaces here as a caught error and a
  // retry, instead of an uncaught exception that would kill the retry chain and
  // leave the button gone until the next navigation.
  function attempt(check) {
    try {
      return check();
    } catch (error) {
      debugLog("download button check failed", error);
      return false;
    }
  }

  // Short and growing: the row is usually there within a frame or two, and a
  // failed attempt is cheap (an id lookup plus two queries) so the backoff can
  // stay aggressive at the start and relax to a second when the page is slow.
  function scheduleRetry() {
    if (retryTimer !== null) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      if (attempt(ensureButton)) {
        retryDelay = RETRY_MIN_MS;
        return;
      }
      // Re-arm from inside the callback instead of waiting for the next
      // mutation. A page that goes quiet after a failed attempt (a slow
      // connection, a throttled tab, a paused player) produces no further
      // mutations, and a one-shot timer gives up at exactly that point.
      retryDelay = Math.min(RETRY_MAX_MS, Math.round(retryDelay * 1.6));
      scheduleRetry();
    }, retryDelay);
  }

  function onMutations() {
    // Deliberately not deferred to requestAnimationFrame any more. The observer
    // already delivers one callback per batch, so the extra frame bought nothing
    // and cost two real problems: frames are suspended in a background tab, so a
    // video changed while the tab was hidden was not repaired until the tab came
    // back; and the repair lost the race with the paint, so the action row was
    // visibly empty for a frame on every change (ours removed, YouTube's hidden).
    if (!attempt(ensureButton)) scheduleRetry();
  }

  function onPoll() {
    // A page that is no longer a watch page -- a navigation whose event never
    // reached us -- disarms itself here rather than idling on every page the
    // user visits afterwards.
    if (!activeLayout()) {
      disarmWatchdog();
      removeButton();
      return;
    }
    // The thorough check: this is where a button that is present but sitting in
    // a stale or hidden row is moved. One layout read per tick, which is why it
    // lives here and not on the mutation path.
    if (!attempt(verifyButton)) scheduleRetry();
  }

  function armWatchdog() {
    // Observed on the document element rather than on body: a page that replaces
    // its own body would otherwise leave the observer watching a detached tree,
    // and nothing would ever be seen again.
    if (!observer && document.documentElement) {
      observer = new MutationObserver(onMutations);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    }
    if (pollTimer === null) pollTimer = window.setInterval(onPoll, POLL_MS);
    // Reset the backoff: a fresh navigation deserves a fast first attempt.
    retryDelay = RETRY_MIN_MS;
    scheduleRetry();
  }

  function disarmWatchdog() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
    retryDelay = RETRY_MIN_MS;
  }

  // Called when the tab becomes visible again (and when the window regains
  // focus). Both are events this content script would otherwise never hear, and
  // both happen right before the user looks at the page -- the worst possible
  // moment to be missing a button. It is also the catch-all for a navigation
  // whose event never reached us at all: if no watchdog is armed and this is a
  // watch page, one is armed here.
  function onForeground() {
    if (!activeLayout()) {
      removeButton();
      disarmWatchdog();
      return;
    }
    if (!observer) armWatchdog();
    attempt(verifyButton);
  }

  // YouTube does not reload the page when moving between videos, so a one-shot
  // injection at load time would miss every navigation after the first. React to
  // the app's own navigation event and to history changes.
  //
  // Whatever happens here, the watchdog is armed afterwards: yt-navigate-finish
  // is not a reliable "the new row is in the DOM" signal. Depending on the
  // navigation it fires before YouTube has built the new action row, or after it
  // has already built and will shortly replace it again. Arming unconditionally
  // is what makes the button survive both orderings.
  function onNavigate() {
    syncTheme();
    // The popup is built for the video that is being left, so it always goes.
    closePopup();
    if (!activeLayout()) {
      removeButton();
      disarmWatchdog();
      return;
    }
    // The button itself is deliberately NOT torn down and rebuilt here. It used
    // to be, which guaranteed a window with no button on every navigation, and
    // with YouTube's own button hidden by our ready class that window was an
    // empty action row. The button is tied to no particular video -- it reads
    // window.location.href when it is clicked -- so the watchdog keeping it in
    // step with the DOM is all that is needed.
    try {
      // Best effort, so a video that is already on screen has the button in the
      // same task rather than a retry or a poll tick later.
      attempt(verifyButton);
    } finally {
      // Armed even if the check threw: the observer is the only thing that can
      // repair the button afterwards.
      armWatchdog();
    }
  }

  // ---------------------------------------------------------------- popup ----

  function closePopup() {
    const overlay = document.getElementById(POPUP_ID);
    if (overlay) overlay.remove();
  }

  // `id` is unused now: the radio ids are derived from the group name so that
  // they cannot collide with an element of the host page, and `common` is what
  // the bridge actually understands.
  const FORMAT_OPTIONS = [
    { common: "UHD", label: "2160p (4k)", checked: false },
    { common: "QHD", label: "1440p (2k)", checked: false },
    { common: "FHD", label: "1080p", checked: true },
    { common: "HD", label: "720p", checked: false },
    { common: "SD", label: "480p", checked: false },
    { common: "mp3", label: "mp3", checked: false },
  ];

  function element(tag, id, className) {
    const node = document.createElement(tag);
    if (id) node.id = id;
    if (className) node.className = className;
    return node;
  }

  function buildFormatRow(format, index) {
    const row = element("div", null, "popup-format-box");
    const radio = element("input");
    radio.id = `${FORMAT_NAME}-${index}`;
    radio.type = "radio";
    // A private group name: "mediaFormat" is a generic enough name that a
    // document-wide query for it could pick up a radio from the host page.
    radio.name = FORMAT_NAME;
    radio.checked = format.checked;
    radio.dataset.format = format.common;

    const label = element("label");
    // Ties the text to the control, so clicking the label selects the row and
    // screen readers announce the option instead of an unlabelled radio.
    label.htmlFor = radio.id;
    label.textContent = format.label;

    const common = element("span");
    common.textContent = format.common;

    // The whole row selects, so the target is a comfortable 40px tall instead
    // of only the 20px radio.
    row.addEventListener("click", () => {
      radio.checked = true;
    });

    row.append(radio, label, common);
    return row;
  }

  function buildPopup(pageUrl) {
    const overlay = element("div", POPUP_ID);
    // Clicking the backdrop closes. The clicks are also stopped from reaching
    // the page underneath, which would otherwise be a YouTube element that
    // reacts to stray clicks.
    overlay.addEventListener("click", (event) => {
      event.stopPropagation();
      if (event.target === overlay) closePopup();
    });

    const box = element("div", "ambxst-ytd-popup-box");
    overlay.appendChild(box);

    const header = element("div", "ambxst-ytd-popup-header");
    // The icon is the project mark, the same glyph as the button, built as a
    // real inline svg so it inherits the theme colour from CSS. A bare div with
    // no background image (which is what this used to be) rendered as an empty
    // 50px gap.
    const icon = element("div", "ambxst-ytd-popup-icon");
    icon.innerHTML = svgInnerHtml;
    const title = element("div", "ambxst-ytd-popup-title");
    title.textContent = "Download Video";
    header.append(icon, title);
    box.appendChild(header);

    const selection = element("div", "ambxst-ytd-popup-format-selection");
    FORMAT_OPTIONS.forEach((format, index) => {
      selection.appendChild(buildFormatRow(format, index));
    });
    box.appendChild(selection);

    const confirm = element("button", "ambxst-ytd-popup-download-button");
    confirm.type = "button";
    confirm.textContent = "Download";
    confirm.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      // Scoped to this popup. A document-wide lookup could resolve to a radio
      // belonging to the page or to a second popup, and would then send a
      // format the user never picked.
      const selected = overlay.querySelector(
        `input[name="${FORMAT_NAME}"]:checked`
      );
      if (!selected) return;
      const request = YtdExtensionUrl.buildRequest(
        pageUrl,
        selected.dataset.format
      );
      // Close first: handing the URL to the browser does not unload the page
      // (the protocol handler is a separate application), so the overlay would
      // otherwise stay on screen behind the download dialog.
      closePopup();
      // url.js inserts the format into the query string instead of appending it,
      // so a page URL with no query string, or one ending in a "#fragment",
      // still sends a readable format and keeps its other parameters.
      window.location.href = request;
    });
    box.appendChild(confirm);

    const close = element("button", "ambxst-ytd-popup-close-button");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      closePopup();
    });
    box.appendChild(close);

    return overlay;
  }

  function onButtonClick(event) {
    // The button is a real <button> living inside YouTube's action row, so a
    // plain click also reaches the row's own listeners. Swallow it: YouTube
    // must not treat our button as one of its own.
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    // Guard against stacking popups on a fast double click.
    if (document.getElementById(POPUP_ID)) return;
    const host = document.body || document.documentElement;
    if (!host) return;
    host.appendChild(buildPopup(currentPageUrl()));
  }

  // ------------------------------------------------------------------ init ----

  // Escape closes the popup, which is what users expect from an overlay. The
  // listener is permanent (it is one function for the life of the page) but the
  // work it does is a single guarded lookup.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!document.getElementById(POPUP_ID)) return;
    event.stopPropagation();
    closePopup();
  });

  // The button copies the height of the button next to it, and YouTube's action
  // row grows and shrinks with the viewport, so the measurement has to be
  // repeated. Coalesced into one frame per resize burst.
  let resizeFrame = 0;
  window.addEventListener(
    "resize",
    () => {
      if (resizeFrame) return;
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = 0;
        const button = existingButton();
        if (button) matchNeighbourMetrics(button);
      });
    },
    { passive: true }
  );

  // The theme can change without a navigation: following the OS appearance is
  // the default in YouTube, and the setting can also be flipped from the
  // account menu on a page the user never navigates away from.
  const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
  if (colorScheme && typeof colorScheme.addEventListener === "function") {
    colorScheme.addEventListener("change", () => {
      syncTheme();
      const button = existingButton();
      if (button) matchNeighbourMetrics(button);
    });
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) onForeground();
  });
  // focus fires when the window regains focus without the tab ever being
  // reported as hidden (two windows side by side, for instance).
  window.addEventListener("focus", onForeground);

  syncTheme();
  // YouTube fires this for every in-app navigation, including video changes on
  // the watch page. popstate covers the browser back/forward buttons, which the
  // app event does not always accompany.
  window.addEventListener("yt-navigate-finish", onNavigate);
  window.addEventListener("popstate", onNavigate);
  onNavigate();
})();

