// Ambxst YTD browser extension.
//
// The button is injected into YouTube's action row. The interesting part is
// the observer at the bottom: a watch page mutates constantly (player,
// comments, ads, recommendations), so injection has to be idempotent, cheap,
// and re-armed across YouTube's single page app navigation.
(function () {
  "use strict";

  // The project's own mark. Deliberately NOT YouTube's download arrow: this
  // glyph is the project logo and is what tells the custom button apart from
  // YouTube's own download button.
  const BUTTON_ID = "ambxst-ytd-download-button";
  const READY_CLASS = "ambxst-ytd-ready";
  const THEME_ATTRS = ["darky", "lighty"];

  const CONTAINER_SELECTORS = [
    "ytd-watch-metadata #top-level-buttons-computed",
    "#top-level-buttons-computed",
    "ytd-watch-metadata #actions",
  ];
  const ANCHOR_SELECTOR = "segmented-like-dislike-button-view-model";

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

  function isWatchPage() {
    const path = window.location.pathname;
    return path.startsWith("/watch") || path.startsWith("/clip");
  }

  // ---------------------------------------------------------------- theme ----

  // Re-evaluated on every navigation because YouTube is a single page app and
  // the user can switch theme without a reload. Comparing against an exact
  // rgb() string breaks as soon as the browser serialises it differently, so
  // the luminance of the resolved colour decides instead.
  function syncTheme() {
    const root = document.documentElement;
    const color = window.getComputedStyle(root).backgroundColor || "";
    const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
    let isDark = true;
    if (match) {
      const luminance =
        0.2126 * +match[1] + 0.7152 * +match[2] + 0.0722 * +match[3];
      isDark = luminance < 128;
    }
    for (const attr of THEME_ATTRS) root.removeAttribute(attr);
    root.setAttribute(isDark ? "darky" : "lighty", "");
  }

  // ------------------------------------------------------------ injection ----

  function findContainer() {
    for (const selector of CONTAINER_SELECTORS) {
      const found = document.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  function existingButton() {
    return document.getElementById(BUTTON_ID);
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

  function buildButton() {
    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.className = "ambxst-ytd-button";
    button.innerHTML =
      `${svgInnerHtml}<span class="ambxst-ytd-button-label">Download</span>`;
    button.setAttribute("aria-label", "Download with Ambxst YTD");
    button.addEventListener("click", onButtonClick);
    return button;
  }

  // YouTube changes its own button metrics periodically, so a hardcoded height
  // drifts out of line and the button reads as too small next to its
  // neighbours. Measure a real sibling button and adopt its height and pill
  // radius instead. The CSS default stays in place if nothing can be measured.
  function matchNeighbourMetrics(button) {
    const container = findContainer();
    if (!container) return;

    let height = 0;
    for (const node of container.children) {
      if (node === button || node.contains && node.contains(button)) continue;
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

  // Idempotent: safe to call as often as the observer fires.
  function ensureButton() {
    if (!isWatchPage()) {
      removeButton();
      return false;
    }
    if (existingButton()) return true;

    const container = findContainer();
    if (!container) return false;

    const anchor = container.querySelector(ANCHOR_SELECTOR);
    if (!anchor) return false;

    const button = buildButton();
    anchor.insertAdjacentElement("afterend", button);
    matchNeighbourMetrics(button);
    markReady(true);
    debugLog("injected download button");
    return true;
  }

  function removeButton() {
    const button = existingButton();
    if (button) button.remove();
    markReady(false);
    closePopup();
  }

  // ------------------------------------------------------------- observer ----

  // A watch page mutates constantly. The previous version ran a function on
  // every mutation that started a *new* setInterval, and that interval was only
  // cleared on the one branch that happened to find the container, so a busy
  // page accumulated hundreds of live timers. Now there is a single observer,
  // at most one pending retry, and the observer disconnects once the button
  // exists.
  let observer = null;
  let retryTimer = null;
  let pendingFrame = 0;

  function scheduleRetry() {
    if (retryTimer !== null) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      if (ensureButton()) stopObserving();
    }, 250);
  }

  function onMutations() {
    if (pendingFrame) return;
    // Coalesce a burst of mutations into one check per frame.
    pendingFrame = window.requestAnimationFrame(() => {
      pendingFrame = 0;
      if (ensureButton()) stopObserving();
      else scheduleRetry();
    });
  }

  function startObserving() {
    if (observer || !document.body) return;
    observer = new MutationObserver(onMutations);
    observer.observe(document.body, { childList: true, subtree: true });
    // Also poll once on a timer. Waiting only for a mutation means that a page
    // which finishes rendering without a further childList change would never
    // get the button.
    scheduleRetry();
  }

  function stopObserving() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (pendingFrame) {
      window.cancelAnimationFrame(pendingFrame);
      pendingFrame = 0;
    }
  }

  // YouTube does not reload the page when moving between videos, so a one-shot
  // injection at load time would miss every navigation after the first. React
  // to the app's own navigation event and to history changes.
  function onNavigate() {
    syncTheme();
    removeButton();
    stopObserving();
    if (!isWatchPage()) return;
    if (ensureButton()) return;
    startObserving();
  }

  // ---------------------------------------------------------------- popup ----

  function closePopup() {
    const overlay = document.getElementById("popup-bg");
    if (overlay) overlay.remove();
  }

  const FORMAT_OPTIONS = [
    { id: "4k-radio", common: "UHD", label: "2160p (4k)", checked: false },
    { id: "2k-radio", common: "QHD", label: "1440p (2k)", checked: false },
    { id: "1k-radio", common: "FHD", label: "1080p", checked: true },
    { id: "72-radio", common: "HD", label: "720p", checked: false },
    { id: "48-radio", common: "SD", label: "480p", checked: false },
    { id: "au-radio", common: "mp3", label: "mp3", checked: false },
  ];

  function element(tag, id, className) {
    const node = document.createElement(tag);
    if (id) node.id = id;
    if (className) node.className = className;
    return node;
  }

  function buildFormatRow(format) {
    const row = element("div", null, "popup-format-box");
    const radio = element("input");
    radio.id = format.id;
    radio.type = "radio";
    radio.name = "mediaFormat";
    radio.checked = format.checked;
    radio.dataset.format = format.common;

    const label = element("label");
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
    const overlay = element("div", "popup-bg");
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closePopup();
    });

    const box = element("div", "popup-box");
    overlay.appendChild(box);

    const header = element("div", "popup-header");
    const icon = element("div", "popup-icon");
    const title = element("div", "popup-title");
    title.textContent = "Download Video";
    header.append(icon, title);
    box.appendChild(header);

    const selection = element("div", "popup-format-selection");
    for (const format of FORMAT_OPTIONS) {
      selection.appendChild(buildFormatRow(format));
    }
    box.appendChild(selection);

    const confirm = element("button", "popup-download-button");
    confirm.type = "button";
    confirm.textContent = "Download";
    confirm.addEventListener("click", () => {
      const selected = document.querySelector(
        "input[name='mediaFormat']:checked"
      );
      if (!selected) return;
      // url.js inserts the format into the query string instead of appending it,
      // so a page URL with no query string, or one ending in a "#fragment",
      // still sends a readable format and keeps its other parameters.
      window.location.href = YtdExtensionUrl.buildRequest(
        pageUrl,
        selected.dataset.format
      );
    });
    box.appendChild(confirm);

    const close = element("button", "popup-close-button");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", closePopup);
    box.appendChild(close);

    return overlay;
  }

  function onButtonClick() {
    // Guard against stacking popups on a fast double click.
    if (document.getElementById("popup-bg")) return;
    document.body.appendChild(buildPopup(window.location.href));
  }

  // ------------------------------------------------------------------ init ----

  // Escape closes the popup, which is what users expect from an overlay.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePopup();
  });

  syncTheme();
  window.addEventListener("yt-navigate-finish", onNavigate);
  window.addEventListener("popstate", onNavigate);
  onNavigate();
})();

