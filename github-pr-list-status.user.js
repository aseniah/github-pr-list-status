// ==UserScript==
// @name        GitHub PR List Status
// @namespace   https://github.com/aseniah
// @description Colors PRs by age and approval, and adds merge state and line count badges to the pull requests list
// @version     1.4
// @license     MIT
// @updateURL   https://raw.githubusercontent.com/aseniah/github-pr-list-status/main/github-pr-list-status.user.js
// @downloadURL https://raw.githubusercontent.com/aseniah/github-pr-list-status/main/github-pr-list-status.user.js
// @match       https://github.com/*
// @run-at      document-idle
// ==/UserScript==

(function () {
  const CONFIG = {
    // Row color for unapproved PRs, by age. The first entry the PR is younger than wins.
    // Any CSS color works. The --prb-row-* defaults switch between light and dark values with GitHub's theme.
    ageColors: [
      { days: 7, color: "transparent" }, // < 1 week: no highlight
      { days: 14, color: "var(--prb-row-yellow)" }, // 1–2 weeks: yellow
      { days: 30, color: "var(--prb-row-orange)" }, // 2–4 weeks: orange
      { days: Infinity, color: "var(--prb-row-red)" }, // > 1 month: red
    ],
    approvedColor: "var(--prb-row-green)", // green

    // A failing check matching one of these gets its own badge instead of counting toward "N failing".
    // match: exact check name or a RegExp. style: purple, blue, red, yellow, gray, or green.
    namedChecks: [
      { match: "Release Check", label: "🔒 Pipeline", style: "purple" },
    ],

    // People matching these are left out of the review counts. match: exact login or a RegExp.
    ignoredReviewers: [/\[bot\]$/i, /^copilot/i],

    // Leave lockfiles out of the line counts so dependency upgrades show the reviewable size.
    // This and flagWaitingThreads are defaults. Choices made in the settings panel take precedence.
    excludeLockfiles: true,
    lockfilePattern:
      /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Gemfile\.lock|Cargo\.lock|composer\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|go\.sum|flake\.lock)$/,

    // On PRs you opened, count unresolved threads waiting on your reply or reaction.
    // Adds one request for each of your PRs that has comments.
    flagWaitingThreads: true,

    // Moving between lists without reloading reuses results this recent. Reloading always fetches fresh data.
    cacheMinutes: 1,
    // While the tab is visible, PRs showing "Checking…" refetch this often. Other badges update on reload.
    checkingRefreshSeconds: 60,
    maxConcurrentPrs: 4,
  };

  // Undocumented endpoints the PR page itself calls. They return 406 without X-Requested-With.
  const PAGE_DATA_HEADERS = {
    Accept: "application/json",
    "X-Requested-With": "XMLHttpRequest",
  };
  const CACHE_TTL_MS = CONFIG.cacheMinutes * 60 * 1000;

  const FEATURES = [
    {
      key: "rowColors",
      label: "Row colors",
      description: "Age and approval colors. No requests.",
      default: true,
    },
    {
      key: "mergeState",
      label: "Merge state",
      description:
        "Ready, Behind, Conflicts, and Blocked. Shares a request with review counts.",
      default: true,
    },
    {
      key: "checks",
      label: "Check details",
      description:
        "Failing counts, named checks, and running checks. 1 request per PR.",
      default: true,
    },
    {
      key: "lineCounts",
      label: "Line counts",
      description: "Lines added and deleted. 1 request per PR.",
      default: true,
    },
    {
      key: "excludeLockfiles",
      label: "Leave out lockfiles",
      description: "Lists every file in the PR, so it costs more on large PRs.",
      parent: "lineCounts",
      default: CONFIG.excludeLockfiles,
    },
    {
      key: "reviewCounts",
      label: "Review counts",
      description:
        "Approvals and change requests. Shares a request with merge state.",
      default: true,
    },
    {
      key: "commenters",
      label: "Commenters and re-review",
      description: "Commenter count and the re-review eye. 1 request per PR.",
      default: true,
    },
    {
      key: "waitingThreads",
      label: "Threads waiting on you",
      description: "On your PRs only. 1 request per PR with comments.",
      default: CONFIG.flagWaitingThreads,
    },
  ];
  const FEWER_REQUESTS_OFF = new Set([
    "checks",
    "excludeLockfiles",
    "commenters",
    "waitingThreads",
  ]);
  const HIGHLIGHT_STYLES = ["solid", "rainbow"];
  // Only choices that differ from the defaults are stored, so changing a default in CONFIG still applies.
  const SETTINGS_KEY = "prb-settings";
  let settings = loadSettings();

  function loadSettings() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    } catch {}
    const features = {};
    FEATURES.forEach((f) => {
      const value = saved.features?.[f.key];
      features[f.key] = typeof value === "boolean" ? value : f.default;
    });
    const authors = Array.isArray(saved.authors)
      ? saved.authors.filter((a) => typeof a === "string")
      : [];
    return {
      features,
      authors: new Set(authors.map((a) => a.toLowerCase())),
      style: HIGHLIGHT_STYLES.includes(saved.style) ? saved.style : "solid",
    };
  }

  function saveSettings() {
    const saved = {};
    const changed = FEATURES.filter(
      (f) => settings.features[f.key] !== f.default,
    );
    if (changed.length)
      saved.features = Object.fromEntries(
        changed.map((f) => [f.key, settings.features[f.key]]),
      );
    if (settings.authors.size) saved.authors = [...settings.authors].sort();
    if (settings.style !== "solid") saved.style = settings.style;
    try {
      if (Object.keys(saved).length)
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved));
      else localStorage.removeItem(SETTINGS_KEY);
    } catch {}
  }

  function isOn(key) {
    return settings.features[key];
  }

  // A feature shows only when it's on now and was on when the PR's data was fetched.
  function shows(info, key) {
    return isOn(key) && !!info.features?.[key];
  }

  // Waiting threads load separately, so only the features loadPrInfo fetches count here.
  function needsRefetch(info) {
    const missing = FEATURES.some(
      (f) =>
        f.key !== "waitingThreads" &&
        f.key !== "excludeLockfiles" &&
        settings.features[f.key] &&
        !info.features?.[f.key],
    );
    const lockfilesChanged =
      isOn("lineCounts") &&
      info.features?.excludeLockfiles !== isOn("excludeLockfiles");
    return missing || lockfilesChanged;
  }

  const STYLE_CLASSES = {
    purple: "prb-release",
    blue: "prb-blue",
    red: "prb-failing",
    yellow: "prb-behind",
    gray: "prb-blocked",
    green: "prb-ready",
  };
  const PASSING_CHECK_STATES = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
  const FAILING_CHECK_STATES = new Set([
    "FAILURE",
    "ERROR",
    "CANCELLED",
    "TIMED_OUT",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
    "STALE",
  ]);

  // Primer octicon comment-discussion-16 (MIT). Two bubbles, so it doesn't read as GitHub's comment count.
  const DISCUSSION_ICON_PATH =
    "M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z";

  // Primer octicon eye-16 (MIT).
  const EYE_ICON_PATH =
    "M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.83.88 9.576.43 8.898a1.62 1.62 0 0 1 0-1.798c.45-.677 1.367-1.931 2.637-3.022C4.33 2.992 6.019 2 8 2ZM1.679 7.932a.12.12 0 0 0 0 .136c.411.622 1.241 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5c1.473 0 2.825-.742 3.955-1.715 1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 0 0 0-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5c-1.473 0-2.825.742-3.955 1.715-1.124.967-1.954 2.096-2.366 2.717ZM8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10Z";

  // Primer octicon info-16 (MIT).
  const INFO_ICON_PATH =
    "M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z";

  // Primer octicons gear-16, list-unordered-16, and triangle-down-16 (MIT).
  const GEAR_ICON_PATH =
    "M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.385.506.792.704 1.218.315.675.111 1.422-.364 1.891l-.814.806c-.049.048-.098.147-.088.294.016.257.016.515 0 .772-.01.147.038.246.088.294l.814.806c.475.469.679 1.216.364 1.891a7.977 7.977 0 0 1-.704 1.217c-.428.61-1.176.807-1.82.63l-1.102-.302c-.067-.019-.177-.011-.3.071a5.909 5.909 0 0 1-.668.386c-.133.066-.194.158-.211.224l-.29 1.106c-.168.646-.715 1.196-1.458 1.26a8.006 8.006 0 0 1-1.402 0c-.743-.064-1.289-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.738 5.738 0 0 1-.668-.386c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a8.12 8.12 0 0 1-.704-1.218c-.315-.675-.111-1.422.363-1.891l.815-.806c.05-.048.098-.147.088-.294a6.214 6.214 0 0 1 0-.772c.01-.147-.038-.246-.088-.294l-.815-.806C.635 6.045.431 5.298.746 4.623a7.92 7.92 0 0 1 .704-1.217c.428-.61 1.176-.807 1.82-.63l1.102.302c.067.019.177.011.3-.071.214-.143.437-.272.668-.386.133-.066.194-.158.211-.224l.29-1.106C6.009.645 6.556.095 7.299.03 7.53.01 7.764 0 8 0Zm-.571 1.525c-.036.003-.108.036-.137.146l-.289 1.105c-.147.561-.549.967-.998 1.189-.173.086-.34.183-.5.29-.417.278-.97.423-1.529.27l-1.103-.303c-.109-.03-.175.016-.195.045-.22.312-.412.644-.573.99-.014.031-.021.11.059.19l.815.806c.411.406.562.957.53 1.456a4.709 4.709 0 0 0 0 .582c.032.499-.119 1.05-.53 1.456l-.815.806c-.081.08-.073.159-.059.19.162.346.353.677.573.989.02.03.085.076.195.046l1.102-.303c.56-.153 1.113-.008 1.53.27.161.107.328.204.501.29.447.222.85.629.997 1.189l.289 1.105c.029.109.101.143.137.146a6.6 6.6 0 0 0 1.142 0c.036-.003.108-.036.137-.146l.289-1.105c.147-.561.549-.967.998-1.189.173-.086.34-.183.5-.29.417-.278.97-.423 1.529-.27l1.103.303c.109.029.175-.016.195-.045.22-.313.411-.644.573-.99.014-.031.021-.11-.059-.19l-.815-.806c-.411-.406-.562-.957-.53-1.456a4.709 4.709 0 0 0 0-.582c-.032-.499.119-1.05.53-1.456l.815-.806c.081-.08.073-.159.059-.19a6.464 6.464 0 0 0-.573-.989c-.02-.03-.085-.076-.195-.046l-1.102.303c-.56.153-1.113.008-1.53-.27a4.44 4.44 0 0 0-.501-.29c-.447-.222-.85-.629-.997-1.189l-.289-1.105c-.029-.11-.101-.143-.137-.146a6.6 6.6 0 0 0-1.142 0ZM11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM9.5 8a1.5 1.5 0 1 0-3.001.001A1.5 1.5 0 0 0 9.5 8Z";
  const LIST_ICON_PATH =
    "M5.75 2.5h8.5a.75.75 0 0 1 0 1.5h-8.5a.75.75 0 0 1 0-1.5Zm0 5h8.5a.75.75 0 0 1 0 1.5h-8.5a.75.75 0 0 1 0-1.5Zm0 5h8.5a.75.75 0 0 1 0 1.5h-8.5a.75.75 0 0 1 0-1.5ZM2 14a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm1-6a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM2 4a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z";
  const CARET_ICON_PATH =
    "m4.427 7.427 3.396 3.396a.25.25 0 0 0 .354 0l3.396-3.396A.25.25 0 0 0 11.396 7H4.604a.25.25 0 0 0-.177.427Z";

  // Primer octicon reply-16 (MIT).
  const REPLY_ICON_PATH =
    "M6.78 1.97a.75.75 0 0 1 0 1.06L3.81 6h6.44A4.75 4.75 0 0 1 15 10.75v2.5a.75.75 0 0 1-1.5 0v-2.5a3.25 3.25 0 0 0-3.25-3.25H3.81l2.97 2.97a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L.47 7.28a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z";

  const BADGE_CSS = `
    :root { --prb-row-yellow: #fff8c5; --prb-row-orange: #ffd8b1; --prb-row-red: #ffd0d0; --prb-row-green: #c8f5c8; --prb-hl-solid: #6e7781; }
    [data-color-mode="dark"] { --prb-row-yellow: #2f2a05; --prb-row-orange: #3d1f0d; --prb-row-red: #3c0614; --prb-row-green: #122117; --prb-hl-solid: #6e7681; }
    @media (prefers-color-scheme: dark) {
      [data-color-mode="auto"] { --prb-row-yellow: #2f2a05; --prb-row-orange: #3d1f0d; --prb-row-red: #3c0614; --prb-row-green: #122117; --prb-hl-solid: #6e7681; }
    }
    .prb-group { float: right; display: inline-flex; gap: 6px; margin: 2px 16px 0 12px; }
    .prb { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 500; line-height: 18px; padding: 0 7px; border-radius: 2em; border: 1px solid transparent; white-space: nowrap; }
    .prb-size { background: var(--bgColor-default, #fff); border-color: var(--borderColor-default, #d1d9e0); color: var(--fgColor-muted, #59636e); font-variant-numeric: tabular-nums; }
    .prb-size .add { color: var(--fgColor-success, #1a7f37); }
    .prb-size .del { color: var(--fgColor-danger, #d1242f); }
    .prb-ready    { background: var(--bgColor-success-emphasis, #1a7f37); color: var(--fgColor-onEmphasis, #fff); }
    .prb-behind   { background: var(--bgColor-attention-muted, #fff8c5); border-color: var(--borderColor-attention-emphasis, #d4a72c); color: var(--fgColor-attention, #9a6700); }
    .prb-conflict { background: var(--bgColor-danger-muted, #ffebe9); border-color: var(--borderColor-danger-muted, #ff818266); color: var(--fgColor-danger, #d1242f); }
    .prb-failing  { background: var(--bgColor-danger-muted, #ffebe9); border-color: var(--borderColor-danger-muted, #ff818266); color: var(--fgColor-danger, #d1242f); }
    .prb-release  { background: var(--bgColor-done-muted, #fbefff); border-color: var(--borderColor-done-muted, #c297ff); color: var(--fgColor-done, #8250df); }
    .prb-blue     { background: var(--bgColor-accent-muted, #ddf4ff); border-color: var(--borderColor-accent-muted, #54aeff66); color: var(--fgColor-accent, #0969da); }
    .prb-running  { background: var(--bgColor-default, #fff); border-color: var(--borderColor-attention-emphasis, #d4a72c); color: var(--fgColor-attention, #9a6700); }
    .prb-blocked  { background: var(--bgColor-neutral-muted, #f6f8fa); border-color: var(--borderColor-default, #d1d9e0); color: var(--fgColor-muted, #59636e); }
    .prb-loading  { background: var(--bgColor-default, #fff); border-color: var(--borderColor-default, #d1d9e0); }
    .prb-spinner { width: 10px; height: 10px; border: 2px solid var(--borderColor-default, #d1d9e0); border-top-color: var(--fgColor-muted, #59636e); border-radius: 50%; animation: prb-spin 0.7s linear infinite; }
    @keyframes prb-spin { to { transform: rotate(360deg); } }
    .prb-dots { margin-left: -4px; }
    .prb-dots span { animation: prb-dot 1.4s infinite; opacity: 0.25; }
    .prb-dots span:nth-child(2) { animation-delay: 0.2s; }
    .prb-dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes prb-dot { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { .prb-dots span { animation: none; opacity: 1; } }
    .prb-meta-stack { flex-wrap: wrap; justify-content: flex-end; align-content: center; row-gap: 6px; }
    /* The slot reserves the second line. Counts are positioned out of flow so they never widen the column. */
    .prb-reviews { flex-basis: 100%; height: 18px; position: relative; }
    .prb-review-counts { position: absolute; top: 0; right: 0; display: inline-flex; align-items: center; gap: 8px; line-height: 18px; font-size: 12px; color: var(--fgColor-muted, #59636e); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .prb-review-counts .ok { color: var(--fgColor-success, #1a7f37); }
    .prb-review-counts .chg { color: var(--fgColor-danger, #d1242f); }
    .prb-review-counts > span { display: inline-flex; align-items: center; gap: 3px; }
    .prb-review-counts svg { width: 14px; height: 14px; fill: currentColor; }
    .prb-review-counts .rereq svg { width: 16px; height: 16px; }
    .prb-review-counts .rereq circle { fill: var(--bgColor-accent-emphasis, #0969da); }
    .prb-review-counts .rereq path { fill: var(--fgColor-onEmphasis, #fff); }
    .prb-review-counts .waiting { color: var(--fgColor-accent, #0969da); font-weight: 600; }
    .prb-review-counts .waiting svg { width: 16px; height: 16px; }
    .prb-review-counts .waiting circle { fill: var(--bgColor-accent-emphasis, #0969da); }
    .prb-review-counts .waiting path { fill: var(--fgColor-onEmphasis, #fff); }
    .prb-error { color: var(--fgColor-muted, #59636e); font-size: 14px; line-height: 18px; cursor: help; }
    .prb-status { margin-left: auto; text-align: right; font-size: 12px; color: var(--fgColor-attention, #9a6700); }
    .prb-status:empty { display: none; }
    .prb-status > span { cursor: help; }
    .prb-status button { margin-left: 4px; padding: 0; border: 0; background: none; font: inherit; color: var(--fgColor-accent, #0969da); cursor: pointer; }
    .prb-status button:hover { text-decoration: underline; }
    .prb-legend { margin-top: 8px; border: 1px solid var(--borderColor-default, #d1d9e0); border-radius: 6px; font-size: 12px; color: var(--fgColor-muted, #59636e); }
    .prb-legend-body { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 16px 48px; padding: 12px 16px 16px; }
    .prb-legend-body > div { flex: 0 1 auto; min-width: 260px; }
    .prb-legend h4 { margin: 0 0 8px; font-size: 12px; font-weight: 600; color: var(--fgColor-default, #1f2328); }
    .prb-legend dl { display: grid; grid-template-columns: max-content 1fr; gap: 8px 12px; align-items: start; margin: 0; }
    .prb-legend dt { display: flex; align-items: center; min-height: 20px; }
    .prb-legend dd { margin: 0; line-height: 20px; }
    .prb-legend-swatch { width: 32px; height: 16px; border-radius: 4px; border: 1px solid var(--borderColor-default, #d1d9e0); }
    .prb-legend .prb-review-counts { position: static; }
    .prb-footer-bar { display: flex; align-items: center; gap: 12px; margin-top: 8px; min-height: 20px; }
    .prb-footer-title { font-size: 12px; color: var(--fgColor-muted, #59636e); padding-right: 12px; border-right: 1px solid var(--borderColor-default, #d1d9e0); line-height: 16px; text-decoration: none; }
    .prb-footer-title:hover { color: var(--fgColor-accent, #0969da); text-decoration: underline; }
    .prb-footer-toggle { display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; background: none; font: inherit; font-size: 12px; color: var(--fgColor-muted, #59636e); cursor: pointer; }
    .prb-footer-toggle:hover, .prb-footer-toggle[aria-expanded="true"] { color: var(--fgColor-default, #1f2328); }
    .prb-footer-toggle:hover .prb-toggle-label { text-decoration: underline; }
    .prb-footer-toggle svg { width: 14px; height: 14px; fill: currentColor; }
    .prb-footer-toggle .caret { width: 12px; height: 12px; transition: transform 0.15s; }
    .prb-footer-toggle[aria-expanded="true"] .caret { transform: rotate(180deg); }
    .prb-hl.prb-hl-solid, .prb-hl.prb-hl-rainbow { padding: 1px 5px; margin: 0 -2px; border-radius: 2em; text-decoration: none; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
    /* Contrasts at least 3:1 with every row color in both themes, and 4.5:1 with its white text. */
    .prb-hl.prb-hl-solid { background: var(--prb-hl-solid); color: #fff; }
    .prb-hl.prb-hl-rainbow { color: #fff; text-shadow: 0 1px 1px rgba(0, 0, 0, 0.4); background: repeating-linear-gradient(90deg, #cf222e 0, #bc4c00 40px, #9a6700 80px, #1a7f37 120px, #0969da 160px, #8250df 200px, #cf222e 240px); background-attachment: fixed; animation: prb-rainbow 3s linear infinite; }
    @keyframes prb-rainbow { to { background-position: 240px 0; } }
    @media (prefers-reduced-motion: reduce) { .prb-hl.prb-hl-rainbow { animation: none; } }
    .prb-panel-body { display: flex; flex-wrap: wrap; gap: 16px 48px; padding: 12px 16px 16px; }
    .prb-panel-body > section { flex: 1 1 340px; }
    .prb-section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; min-height: 24px; }
    .prb-legend .prb-section-head h4 { margin: 0; }
    .prb-head-controls { display: inline-flex; align-items: center; gap: 6px; }
    .prb-info { position: relative; display: inline-flex; color: var(--fgColor-muted, #59636e); cursor: help; border-radius: 50%; }
    .prb-info:focus-visible { outline: 2px solid var(--fgColor-accent, #0969da); outline-offset: 1px; }
    .prb-info svg { width: 14px; height: 14px; fill: currentColor; }
    .prb-tip { display: none; position: absolute; top: calc(100% + 6px); right: -8px; z-index: 10; width: 300px; padding: 8px 10px; border: 1px solid var(--borderColor-default, #d1d9e0); border-radius: 6px; background: var(--bgColor-default, #fff); box-shadow: 0 8px 24px rgba(37, 41, 46, 0.12); color: var(--fgColor-default, #1f2328); font-size: 12px; font-weight: 400; line-height: 18px; text-align: left; }
    .prb-tip p { margin: 0; }
    .prb-tip p + p { margin-top: 6px; }
    .prb-info:hover .prb-tip, .prb-info:focus .prb-tip { display: block; }
    .prb-note { margin: 8px 0 0; line-height: 18px; }
    .prb-authors { display: flex; flex-wrap: wrap; gap: 6px; }
    .prb-author-btn { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border: 1px solid var(--borderColor-default, #d1d9e0); border-radius: 2em; background: var(--bgColor-default, #fff); color: var(--fgColor-default, #1f2328); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; }
    .prb-author-btn[aria-pressed="true"] { border-color: var(--fgColor-muted, #59636e); }
    .prb-author-btn .check { width: 10px; }
    .prb-author-btn.absent { color: var(--fgColor-muted, #59636e); border-style: dashed; }
    .prb-seg { display: inline-flex; padding: 2px; border-radius: 6px; background: var(--bgColor-neutral-muted, #818b981f); }
    .prb-seg button { padding: 0 10px; height: 22px; border: 1px solid transparent; border-radius: 5px; background: none; color: var(--fgColor-muted, #59636e); font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; }
    .prb-seg button[aria-pressed="true"] { background: var(--bgColor-default, #fff); border-color: var(--borderColor-default, #d1d9e0); color: var(--fgColor-default, #1f2328); font-weight: 600; }
    .prb-toggles { display: grid; gap: 8px; margin: 0; }
    .prb-toggles label { display: grid; grid-template-columns: 16px 1fr; column-gap: 8px; align-items: start; cursor: pointer; font-weight: 400; line-height: 18px; }
    .prb-toggles input { margin: 2px 0 0; }
    .prb-toggles .name { color: var(--fgColor-default, #1f2328); font-weight: 500; }
    .prb-toggles .indent { margin-left: 24px; }
    .prb-toggles label.disabled { opacity: 0.5; cursor: default; }
  `;

  function getColor(date) {
    const ageDays = (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24);
    return (
      CONFIG.ageColors.find((t) => ageDays < t.days)?.color ?? "transparent"
    );
  }

  function isApproved(row) {
    // Old experience: text like "Approved" often sits in a span near the status area
    const reviewIcon = row.querySelector(
      '[data-testid="review-decision-icon"]',
    );
    if (reviewIcon && reviewIcon.textContent.includes("Approved")) return true;

    // Fallback: search any element with an aria-label mentioning Approved,
    // or plain text "Approved" inside the row (old UI sometimes just has a label/span)
    const ariaMatch = row.querySelector('[aria-label*="Approved"]');
    if (ariaMatch) return true;

    return Array.from(row.querySelectorAll("span, div")).some(
      (el) => el.textContent.trim() === "Approved",
    );
  }

  function applyHighlight(row, timeEl) {
    const datetime = timeEl.getAttribute("datetime");
    if (!datetime) return;
    if (!isOn("rowColors")) {
      row.style.backgroundColor = "";
      return;
    }

    const color = isApproved(row)
      ? CONFIG.approvedColor
      : getColor(new Date(datetime));
    row.style.backgroundColor = color;
    row.style.transition = "background-color 0.2s";
  }

  const memoryCache = new Map();
  const threadsCache = new Map();
  const queue = [];
  let activeCount = 0;
  // Set by any 429. Nothing else is requested until the user retries or reloads.
  let rateLimited = false;

  function schedule(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      pumpQueue();
    });
  }

  function pumpQueue() {
    if (rateLimited) {
      queue
        .splice(0)
        .forEach(({ reject }) =>
          reject(Object.assign(new Error("skipped"), { skipped: true })),
        );
      return;
    }
    while (activeCount < CONFIG.maxConcurrentPrs && queue.length) {
      const { task, resolve, reject } = queue.shift();
      activeCount++;
      task()
        .then(resolve, reject)
        .finally(() => {
          activeCount--;
          pumpQueue();
        });
    }
  }

  async function fetchPageData(prPath, endpoint) {
    const response = await fetch(`${prPath}/page_data/${endpoint}`, {
      headers: PAGE_DATA_HEADERS,
      credentials: "same-origin",
    });
    if (response.status === 429) {
      rateLimited = true;
      throw Object.assign(new Error(`${endpoint} returned 429`), {
        rateLimited: true,
      });
    }
    if (!response.ok)
      throw new Error(`${endpoint} returned ${response.status}`);
    return response.json();
  }

  async function loadLineCounts(prPath, excludeLockfiles) {
    if (excludeLockfiles) {
      const tree = await fetchPageData(prPath, "file_tree");
      if (tree.diffs?.length) {
        const counts = { linesAdded: 0, linesDeleted: 0, excludedLines: 0 };
        // file_tree leaves out count fields that are zero.
        tree.diffs.forEach(({ path, linesAdded = 0, linesDeleted = 0 }) => {
          if (CONFIG.lockfilePattern.test(path)) {
            counts.excludedLines += linesAdded + linesDeleted;
          } else {
            counts.linesAdded += linesAdded;
            counts.linesDeleted += linesDeleted;
          }
        });
        return counts;
      }
    }
    const { diffstat } = await fetchPageData(prPath, "diffstat");
    return {
      linesAdded: diffstat.linesAdded,
      linesDeleted: diffstat.linesDeleted,
      excludedLines: 0,
    };
  }

  // Each endpoint is requested only when a feature that needs it is on.
  async function loadPrInfo(prPath) {
    const features = { ...settings.features };
    // merge_box also carries the PR's state, which keeps merged and closed PRs from showing check pills.
    const needsMergeBox =
      features.mergeState ||
      features.reviewCounts ||
      features.commenters ||
      features.checks ||
      features.waitingThreads;
    const [lines, mergeBox, checks, participants] = await Promise.all([
      features.lineCounts
        ? loadLineCounts(prPath, features.excludeLockfiles)
        : null,
      needsMergeBox
        ? fetchPageData(
            prPath,
            "merge_box?merge_method=MERGE&bypass_requirements=false",
          )
        : null,
      features.checks ? fetchPageData(prPath, "status_checks") : null,
      features.commenters
        ? fetchPageData(prPath, "participants").catch((error) => {
            if (error.rateLimited) throw error;
            return { participants: [] };
          })
        : null,
    ]);
    const pr = mergeBox?.pullRequest || {};
    const reviews = pr.latestOpinionatedReviews || [];
    const reviewersWithState = (state) =>
      reviews.filter((r) => r.state === state).map((r) => r.author.login);
    return {
      features,
      ...lines,
      approvedBy: reviewersWithState("APPROVED"),
      changesRequestedBy: reviewersWithState("CHANGES_REQUESTED"),
      participants: (participants?.participants || []).map(
        (p) => p.displayLogin,
      ),
      pendingReviewers: (pr.pendingReviewRequests || [])
        .map((r) => r.reviewer?.login)
        .filter(Boolean),
      mergeStateStatus: pr.mergeStateStatus,
      state: pr.state,
      checks: (checks?.statusChecks || []).map((c) => ({
        name: c.displayName,
        state: c.state,
        description: c.description,
      })),
    };
  }

  // Ages are checked on read because the back-forward cache freezes timers along with the page.
  function cachedLoad(cache, prPath, load, fresh) {
    const entry = cache.get(prPath);
    if (!fresh && entry && Date.now() - entry.at < CACHE_TTL_MS)
      return entry.pending;
    const pending = schedule(load);
    pending.catch(() => {
      if (cache.get(prPath)?.pending === pending) cache.delete(prPath);
    });
    cache.set(prPath, { pending, at: Date.now() });
    return pending;
  }

  function getPrInfo(prPath, { fresh = false } = {}) {
    return cachedLoad(memoryCache, prPath, () => loadPrInfo(prPath), fresh);
  }

  // A thread waits on the viewer when it's unresolved and the viewer neither wrote nor reacted to
  // its last comment. The endpoint returns at most 20 comments per thread, so longer threads count.
  function waitingThreads(threads) {
    const open = threads.filter((t) => !t.isResolved);
    const unchecked = open.filter((t) => t.reviewCommentsLimitExceeded).length;
    const waiting = open.filter((t) => {
      if (t.reviewCommentsLimitExceeded) return true;
      const last = t.commentsData?.comments?.at(-1);
      return (
        last &&
        !last.viewerDidAuthor &&
        !last.reactionGroups?.some((g) => g.reaction?.viewerHasReacted)
      );
    }).length;
    return { waiting, unchecked };
  }

  function getWaitingThreads(prPath, { fresh = false } = {}) {
    return cachedLoad(
      threadsCache,
      prPath,
      async () =>
        waitingThreads((await fetchPageData(prPath, "threads")).threads || []),
      fresh,
    );
  }

  function formatCount(n) {
    if (n < 1000) return String(n);
    return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  }

  function pill(className, text, tooltip) {
    const el = document.createElement("span");
    el.className = `prb ${className}`;
    el.textContent = text;
    if (tooltip) el.title = tooltip;
    return el;
  }

  function sizePill(info) {
    const excluded = info.excludedLines
      ? `\n${info.excludedLines} lockfile lines not counted`
      : "";
    const el = pill(
      "prb-size",
      "",
      `+${info.linesAdded} added, −${info.linesDeleted} deleted${excluded}`,
    );
    const add = document.createElement("span");
    add.className = "add";
    add.textContent = `+${formatCount(info.linesAdded)}`;
    const del = document.createElement("span");
    del.className = "del";
    del.textContent = `−${formatCount(info.linesDeleted)}`;
    el.append(add, " ", del);
    return el;
  }

  // GitHub reports UNKNOWN while it recomputes mergeability, e.g. right after the base branch moves.
  function isUnresolved(info) {
    return (
      isOpen(info) &&
      ((shows(info, "mergeState") && info.mergeStateStatus === "UNKNOWN") ||
        (shows(info, "checks") && info.checks.some(isPending)))
    );
  }

  // Merged and closed PRs report UNKNOWN merge state indefinitely.
  function isOpen(info) {
    return !info.state || info.state === "OPEN";
  }

  function isPending(check) {
    return (
      !PASSING_CHECK_STATES.has(check.state) &&
      !FAILING_CHECK_STATES.has(check.state)
    );
  }

  function checkMatches(match, name) {
    return match instanceof RegExp ? match.test(name) : match === name;
  }

  function checkingPill(tooltip) {
    const checking = pill("prb-running", "● Checking", tooltip);
    const dots = document.createElement("span");
    dots.className = "prb-dots";
    dots.append(
      ...[0, 1, 2].map(() =>
        Object.assign(document.createElement("span"), { textContent: "." }),
      ),
    );
    checking.append(dots);
    return checking;
  }

  function statePills(info, approved) {
    if (!isOpen(info)) return [];
    const pills = [];
    const merge = shows(info, "mergeState");
    const checks = shows(info, "checks") ? info.checks : [];
    const failing = checks.filter((c) => FAILING_CHECK_STATES.has(c.state));
    const namedMatches = CONFIG.namedChecks
      .map((rule) => ({
        rule,
        checks: failing.filter((c) => checkMatches(rule.match, c.name)),
      }))
      .filter((m) => m.checks.length);
    const otherFailing = failing.filter(
      (c) => !namedMatches.some((m) => m.checks.includes(c)),
    );
    const pending = checks.filter(isPending);
    const status = merge ? info.mergeStateStatus : undefined;

    if (status === "DIRTY") {
      pills.push(
        pill(
          "prb-conflict",
          "⚠ Conflicts",
          "Merge conflict with the base branch",
        ),
      );
    }
    namedMatches.forEach(({ rule, checks }) => {
      pills.push(
        pill(
          STYLE_CLASSES[rule.style] || STYLE_CLASSES.gray,
          rule.label,
          checks
            .map((c) => `${c.name}: ${c.description || "failing"}`)
            .join("\n"),
        ),
      );
    });
    if (otherFailing.length) {
      pills.push(
        pill(
          "prb-failing",
          `✗ ${otherFailing.length} failing`,
          `Failing: ${otherFailing.map((c) => c.name).join(", ")}`,
        ),
      );
    }
    // Without check details, merge state can still say that some check is failing.
    if (status === "UNSTABLE" && !shows(info, "checks")) {
      pills.push(pill("prb-failing", "✗ Failing", "Some checks are failing"));
    }
    if (pending.length || status === "UNKNOWN") {
      const tooltip = pending.length
        ? `Pending: ${pending.map((c) => c.name).join(", ")}`
        : "GitHub is still checking whether this can merge";
      pills.push(checkingPill(tooltip));
    }
    if (status === "BEHIND") {
      pills.push(
        pill(
          "prb-behind",
          "↻ Behind",
          "Branch is behind the base branch and needs updating",
        ),
      );
    }

    const clean = status === "CLEAN" || status === "HAS_HOOKS";
    if (!pills.length && clean) {
      pills.push(
        pill("prb-ready", "✓ Ready", "Approved, checks passing, up to date"),
      );
    }
    // GitHub already shows "Review required" for unapproved PRs, so only flag blocks it doesn't explain.
    if (!pills.length && status === "BLOCKED" && approved) {
      pills.push(
        pill(
          "prb-blocked",
          "Blocked",
          "Approved but blocked by a merge requirement",
        ),
      );
    }
    return pills;
  }

  // "Filter by author Full Name (login)", or just the login when there's no display name.
  function authorLabel(row) {
    const label =
      row
        .querySelector('[data-testid="author-filter-link"]')
        ?.getAttribute("aria-label") || "";
    return label.replace(/^Filter by author\s+/, "").trim();
  }

  function prAuthor(row) {
    const label = authorLabel(row);
    return label.match(/\(([^)]+)\)\s*$/)?.[1] ?? label;
  }

  // Approvals and change requests come from each reviewer's latest decision. Anyone else who joined
  // the conversation, other than the author and ignored accounts, counts as a commenter.
  function reviewSummary(info, row) {
    const ignored = (login) =>
      CONFIG.ignoredReviewers.some((m) => checkMatches(m, login));
    const approved = info.approvedBy.filter((l) => !ignored(l));
    const changes = info.changesRequestedBy.filter((l) => !ignored(l));
    const decided = new Set([...approved, ...changes, prAuthor(row)]);
    const commented = info.participants.filter(
      (l) => !decided.has(l) && !ignored(l),
    );
    const decisions = shows(info, "reviewCounts");
    const comments = shows(info, "commenters");
    return [
      {
        className: "ok",
        icon: "✓",
        label: "Approved",
        people: decisions ? approved : [],
      },
      {
        className: "chg",
        icon: "✗",
        label: "Changes requested",
        people: decisions ? changes : [],
      },
      {
        className: "cmt",
        icon: null,
        label: "Commented",
        people: comments ? commented : [],
      },
    ].filter((part) => part.people.length);
  }

  function viewerLogin() {
    return document.querySelector('meta[name="user-login"]')?.content;
  }

  // GitHub's comment count includes review thread comments and is left out when it's zero.
  function wantsWaitingThreads(row) {
    return (
      isOn("waitingThreads") &&
      prAuthor(row) === viewerLogin() &&
      !!row.querySelector("svg.octicon-comment")
    );
  }

  // Submitting a review clears the reviewer's request, so a reviewer who is pending again was re-requested.
  function isReRequested(info) {
    const viewer = viewerLogin();
    if (!shows(info, "commenters")) return false;
    if (!viewer || !info.pendingReviewers.includes(viewer)) return false;
    return [
      ...info.participants,
      ...info.approvedBy,
      ...info.changesRequestedBy,
    ].includes(viewer);
  }

  function discIcon(iconPath, transform) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    const circle = document.createElementNS(ns, "circle");
    circle.setAttribute("cx", "8");
    circle.setAttribute("cy", "8");
    circle.setAttribute("r", "8");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", iconPath);
    path.setAttribute("transform", transform);
    svg.append(circle, path);
    return svg;
  }

  function reRequestIcon() {
    const el = document.createElement("span");
    el.className = "rereq";
    el.append(discIcon(EYE_ICON_PATH, "translate(3 3) scale(0.625)"));
    return el;
  }

  function waitingBadge(waiting) {
    const el = document.createElement("span");
    el.className = "waiting";
    el.append(
      discIcon(REPLY_ICON_PATH, "translate(3.2 3) scale(0.625)"),
      String(waiting),
    );
    return el;
  }

  function waitingTooltip({ waiting, unchecked }) {
    const threads = waiting === 1 ? "thread is" : "threads are";
    const note = unchecked
      ? ` (${unchecked} too long to check, counted to be safe)`
      : "";
    return `${waiting} unresolved ${threads} waiting on your reply or reaction${note}`;
  }

  function discussionIcon() {
    return octicon(DISCUSSION_ICON_PATH);
  }

  function octicon(iconPath) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", iconPath);
    svg.append(path);
    return svg;
  }

  // Every row gets the second line, even when empty, so the comment count always sits level with the
  // title and the column keeps one width down the list.
  function reviewSlot(row) {
    const metadata = [...row.children].find((el) =>
      getComputedStyle(el).gridArea.includes("metadata"),
    );
    if (!metadata) return null;
    let slot = metadata.querySelector(":scope > .prb-reviews");
    if (!slot) {
      slot = document.createElement("span");
      slot.className = "prb-reviews";
      metadata.classList.add("prb-meta-stack");
      metadata.append(slot);
    }
    return slot;
  }

  function renderReviews(row, info, threads) {
    const slot = reviewSlot(row);
    if (!slot) return;
    const parts = reviewSummary(info, row);
    const reRequested = isReRequested(info);
    const waiting = isOn("waitingThreads") && threads?.waiting > 0;
    if (!parts.length && !reRequested && !waiting) {
      slot.replaceChildren();
      return;
    }
    const el = document.createElement("span");
    el.className = "prb-review-counts";
    el.title = [
      ...(waiting ? [waitingTooltip(threads)] : []),
      ...(reRequested ? ["Your review was re-requested"] : []),
      ...parts.map((part) => `${part.label}: ${part.people.join(", ")}`),
    ].join("\n");
    slot.replaceChildren(el);
    if (waiting) el.append(waitingBadge(threads.waiting));
    if (reRequested) el.append(reRequestIcon());
    el.append(
      ...parts.map((part) => {
        const count = document.createElement("span");
        count.className = part.className;
        count.append(part.icon ?? discussionIcon(), String(part.people.length));
        return count;
      }),
    );
  }

  function ensureStyles() {
    if (document.getElementById("prb-styles")) return;
    const style = document.createElement("style");
    style.id = "prb-styles";
    style.textContent = BADGE_CSS;
    document.head.appendChild(style);
  }

  function ageRangeLabel(fromDays, toDays) {
    const unit = (d) =>
      d % 30 === 0
        ? [d / 30, "month"]
        : d % 7 === 0
          ? [d / 7, "week"]
          : [d, "day"];
    const phrase = ([n, u]) => `${n} ${u}${n === 1 ? "" : "s"}`;
    if (!fromDays) return `under ${phrase(unit(toDays))}`;
    if (toDays === Infinity) return `over ${phrase(unit(fromDays))}`;
    const [from, fromUnit] = unit(fromDays);
    const [to, toUnit] = unit(toDays);
    return fromUnit === toUnit
      ? `${from} to ${to} ${toUnit}s`
      : `${phrase([from, fromUnit])} to ${phrase([to, toUnit])}`;
  }

  function legendSection(heading, entries) {
    const list = document.createElement("dl");
    entries.forEach(([term, text]) => {
      const dt = document.createElement("dt");
      dt.append(term);
      const dd = document.createElement("dd");
      dd.textContent = text;
      list.append(dt, dd);
    });
    const section = document.createElement("div");
    section.append(
      Object.assign(document.createElement("h4"), { textContent: heading }),
      list,
    );
    return section;
  }

  function buildLegendBody() {
    const swatch = (color) => {
      const el = document.createElement("span");
      el.className = "prb-legend-swatch";
      el.style.background = color;
      return el;
    };
    const reviewCount = (className, icon) => {
      const counts = document.createElement("span");
      counts.className = "prb-review-counts";
      const count = document.createElement("span");
      count.className = className;
      count.append(icon, "2");
      counts.append(count);
      return counts;
    };
    const sample = sizePill({
      linesAdded: 96,
      linesDeleted: 12,
      excludedLines: 0,
    });
    sample.removeAttribute("title");

    const rowColors = [
      [swatch(CONFIG.approvedColor), "Approved"],
      ...CONFIG.ageColors.map((t, i) => [
        swatch(t.color),
        `Not approved, ${ageRangeLabel(CONFIG.ageColors[i - 1]?.days, t.days)} old`,
      ]),
    ];
    const badges = [
      [
        pill("prb-ready", "✓ Ready"),
        "Approved, checks passing, and up to date",
      ],
      [
        pill("prb-behind", "↻ Behind"),
        "The branch is behind its base and needs updating",
      ],
      [pill("prb-conflict", "⚠ Conflicts"), "The branch has merge conflicts"],
      [
        pill("prb-failing", "✗ 2 failing"),
        "Checks are failing. Hover to see which ones.",
      ],
      [
        checkingPill(),
        "Checks are running, or GitHub is still checking whether it can merge",
      ],
      [
        pill("prb-blocked", "Blocked"),
        "Approved, but a merge requirement is still unmet",
      ],
      ...CONFIG.namedChecks.map((rule) => [
        pill(STYLE_CLASSES[rule.style] || STYLE_CLASSES.gray, rule.label),
        rule.match instanceof RegExp
          ? `A check matching ${rule.match} is failing`
          : `${rule.match} is failing`,
      ]),
      [
        sample,
        isOn("excludeLockfiles")
          ? "Lines added and deleted, not counting lockfiles"
          : "Lines added and deleted",
      ],
      [errorMark(), "Some details didn't load. Hover for why."],
      [authorChip("John Doe (jdoe)"), "An author you chose to highlight"],
    ];
    const reviewSample = (icon) => {
      const counts = document.createElement("span");
      counts.className = "prb-review-counts";
      counts.append(icon);
      return counts;
    };
    const reviews = [
      ...(isOn("waitingThreads")
        ? [
            [
              reviewSample(waitingBadge(2)),
              "Threads awaiting your reply or reaction",
            ],
          ]
        : []),
      [
        reviewSample(reRequestIcon()),
        "You reviewed and were asked to review again",
      ],
      [reviewCount("ok", "✓"), "People who approved"],
      [reviewCount("chg", "✗"), "People who requested changes"],
      [
        reviewCount("cmt", discussionIcon()),
        "People who commented without deciding",
      ],
    ];

    const body = document.createElement("div");
    body.className = "prb-legend-body";
    body.append(
      legendSection("Row colors", rowColors),
      legendSection("Badges", badges),
      legendSection("Reviews", reviews),
    );
    return body;
  }

  function element(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  }

  function authorChip(text) {
    return element("span", {
      className: `prb-hl prb-hl-${settings.style}`,
      textContent: text,
    });
  }

  function applyAuthorHighlight(row) {
    const link = row.querySelector('[data-testid="author-filter-link"]');
    if (!link) return;
    const highlighted = settings.authors.has(prAuthor(row).toLowerCase());
    const wanted = highlighted ? ["prb-hl", `prb-hl-${settings.style}`] : [];
    ["prb-hl", ...HIGHLIGHT_STYLES.map((s) => `prb-hl-${s}`)].forEach(
      (name) => {
        const on = wanted.includes(name);
        if (link.classList.contains(name) !== on)
          link.classList.toggle(name, on);
      },
    );
  }

  function listRows() {
    return [
      ...document.querySelectorAll('[data-testid="timestamp-container"]'),
    ]
      .map((container) => container.closest("li"))
      .filter(Boolean);
  }

  function pageAuthors() {
    const authors = new Map();
    listRows().forEach((row) => {
      const login = prAuthor(row).toLowerCase();
      if (login && !authors.has(login)) authors.set(login, authorLabel(row));
    });
    return authors;
  }

  function authorSignature() {
    return [...pageAuthors()].join("|");
  }

  function segmented(current, options, onSelect) {
    const group = element("span", { className: "prb-seg" });
    options.forEach(([value, text]) => {
      const button = element("button", { type: "button", textContent: text });
      button.setAttribute("aria-pressed", String(current === value));
      button.dataset.prbFocus = `option-${value}`;
      button.addEventListener("click", () => onSelect(value));
      group.append(button);
    });
    return group;
  }

  function infoTip(paragraphs) {
    const tip = element("span", { className: "prb-tip" });
    tip.setAttribute("role", "tooltip");
    paragraphs.forEach(([lead, text]) =>
      tip.append(element("p", {}, element("b", { textContent: lead }), text)),
    );
    const info = element("span", { className: "prb-info", tabIndex: 0 });
    info.setAttribute("aria-label", "More info");
    info.append(octicon(INFO_ICON_PATH), tip);
    return info;
  }

  function currentPreset() {
    if (FEATURES.every((f) => isOn(f.key))) return "all";
    const fewer = FEATURES.every(
      (f) => isOn(f.key) === !FEWER_REQUESTS_OFF.has(f.key),
    );
    return fewer ? "fewer" : null;
  }

  function authorsSection() {
    const onPage = pageAuthors();
    const logins = [...new Set([...onPage.keys(), ...settings.authors])].sort();
    const authors = element("div", { className: "prb-authors" });
    logins.forEach((login) => {
      const on = settings.authors.has(login);
      const name = onPage.get(login) || login;
      const button = element(
        "button",
        { type: "button", className: "prb-author-btn" },
        element("span", { className: "check", textContent: on ? "✓" : "" }),
        on ? authorChip(name) : name,
      );
      button.setAttribute("aria-pressed", String(on));
      button.dataset.prbFocus = `author-${login}`;
      if (!onPage.has(login)) {
        button.classList.add("absent");
        button.title = "No PRs from this author on this page";
      }
      button.addEventListener("click", () => {
        if (on) settings.authors.delete(login);
        else settings.authors.add(login);
        settingsChanged();
      });
      authors.append(button);
    });
    const styles = segmented(
      settings.style,
      [
        ["solid", "Solid"],
        ["rainbow", "🌈 Rainbow"],
      ],
      (style) => {
        settings.style = style;
        settingsChanged();
      },
    );
    return element(
      "section",
      {},
      element(
        "div",
        { className: "prb-section-head" },
        element("h4", { textContent: "Highlighted authors" }),
        styles,
      ),
      authors,
      element("p", {
        className: "prb-note",
        textContent:
          "Click an author to highlight their PRs on every list. Authors you saved stay listed even when they have no PRs on this page, so you can remove them.",
      }),
    );
  }

  function featuresSection() {
    const toggles = element("div", { className: "prb-toggles" });
    FEATURES.forEach((f) => {
      const disabled = !!f.parent && !isOn(f.parent);
      const input = element("input", {
        type: "checkbox",
        checked: isOn(f.key),
        disabled,
      });
      input.dataset.prbFocus = `feature-${f.key}`;
      input.addEventListener("change", () => {
        settings.features[f.key] = input.checked;
        settingsChanged({ features: true });
      });
      const label = element(
        "label",
        {},
        input,
        element(
          "span",
          {},
          element("span", { className: "name", textContent: f.label }),
          element("br"),
          f.description,
        ),
      );
      if (f.parent) label.classList.add("indent");
      if (disabled) label.classList.add("disabled");
      toggles.append(label);
    });
    const presets = segmented(
      currentPreset(),
      [
        ["fewer", "Fewer requests"],
        ["all", "Enable all"],
      ],
      (preset) => {
        FEATURES.forEach((f) => {
          settings.features[f.key] =
            preset === "all" || !FEWER_REQUESTS_OFF.has(f.key);
        });
        settingsChanged({ features: true });
      },
    );
    const info = infoTip([
      [
        "Fewer requests",
        " turns off the features that cost extra requests for each PR. Badges show up sooner, and GitHub is less likely to rate limit you on long lists.",
      ],
      ["Enable all", " turns every feature back on."],
    ]);
    return element(
      "section",
      {},
      element(
        "div",
        { className: "prb-section-head" },
        element("h4", { textContent: "Features" }),
        element("span", { className: "prb-head-controls" }, presets, info),
      ),
      toggles,
    );
  }

  let renderedAuthors = null;
  function renderPanel() {
    const body = document.getElementById("prb-panel-body");
    if (!body) return;
    // Rebuilding drops focus, so put it back on the control that had it.
    const focused = document.activeElement?.dataset?.prbFocus;
    body.replaceChildren(authorsSection(), featuresSection());
    if (focused)
      body
        .querySelector(`[data-prb-focus="${CSS.escape(focused)}"]`)
        ?.focus();
    renderedAuthors = authorSignature();
  }

  function renderLegend() {
    document
      .querySelector("#prb-legend > .prb-legend-body")
      ?.replaceWith(buildLegendBody());
  }

  function footerToggle(iconPath, label, tooltip, panel) {
    const caret = octicon(CARET_ICON_PATH);
    caret.classList.add("caret");
    const button = element(
      "button",
      { type: "button", className: "prb-footer-toggle", title: tooltip },
      octicon(iconPath),
      element("span", { className: "prb-toggle-label", textContent: label }),
      caret,
    );
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", panel.id);
    button.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      button.setAttribute("aria-expanded", String(!panel.hidden));
    });
    return button;
  }

  function addFooter() {
    const list = document
      .querySelector('[data-testid="timestamp-container"]')
      ?.closest("ul")?.parentElement;
    if (!list || list.nextElementSibling?.id === "prb-footer") return;
    document.getElementById("prb-footer")?.remove();
    ensureStyles();
    const settingsPanel = element(
      "div",
      { id: "prb-panel", className: "prb-legend", hidden: true },
      element("div", { id: "prb-panel-body", className: "prb-panel-body" }),
    );
    const legendPanel = element(
      "div",
      { id: "prb-legend", className: "prb-legend", hidden: true },
      buildLegendBody(),
    );
    const title = element("a", {
      className: "prb-footer-title",
      href: "https://github.com/aseniah/github-pr-list-status",
      target: "_blank",
      rel: "noopener",
      title: "PR List Status on GitHub",
      textContent: "PR List Status",
    });
    const bar = element(
      "div",
      { className: "prb-footer-bar" },
      title,
      footerToggle(
        GEAR_ICON_PATH,
        "Settings",
        "PR List Status settings",
        settingsPanel,
      ),
      footerToggle(
        LIST_ICON_PATH,
        "Legend",
        "What the PR List Status colors and badges mean",
        legendPanel,
      ),
      element("div", { id: "prb-status", className: "prb-status" }),
    );
    list.after(
      element("div", { id: "prb-footer" }, bar, settingsPanel, legendPanel),
    );
    renderPanel();
    updateStatus();
  }

  function settingsChanged({ features = false } = {}) {
    saveSettings();
    applySettings({ features });
  }

  // Rows whose data already covers the new settings re-render in place. The rest refetch.
  function applySettings({ features }) {
    if (features) {
      memoryCache.clear();
      document.querySelectorAll(".prb-group").forEach((group) => {
        const row = group.closest("li");
        const info = group.prbInfo;
        if (!row || !info) return;
        if (!renderFetched(group, row, info)) return;
        if (!group.prbThreads && isOpen(info) && wantsWaitingThreads(row))
          loadThreads(group, row, info, { fresh: false });
      });
    }
    highlight();
    renderPanel();
    renderLegend();
  }

  function errorMark(reason) {
    const el = document.createElement("span");
    el.className = "prb-error";
    el.textContent = "⚠";
    if (reason)
      el.title = `PR List Status couldn't load all of this PR's details. ${reason}.`;
    return el;
  }

  function failureReason(error) {
    if (error.skipped)
      return "Skipped after GitHub rate limited an earlier request";
    if (error.rateLimited) return "GitHub rate limited this request";
    return `The request failed (${error.message})`;
  }

  function updateStatus() {
    const status = document.getElementById("prb-status");
    if (!status) return;
    const failed = [...document.querySelectorAll(".prb-group[data-failed]")];
    if (!failed.length) {
      status.replaceChildren();
      return;
    }
    const summary = document.createElement("span");
    const prs = failed.length === 1 ? "1 PR" : `${failed.length} PRs`;
    const cause = rateLimited ? " because GitHub rate limited requests" : "";
    summary.textContent = `⚠ ${prs} didn't fully load${cause} ·`;
    summary.title = failed
      .map(
        (group) =>
          `${group.dataset.prPath.slice(1).replace("/pull/", "#")}: ${group.dataset.failed}`,
      )
      .join("\n");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => {
      rateLimited = false;
      failed.forEach((group) => refreshRow(group, { spinner: true }));
    });
    status.replaceChildren(summary, retry);
  }

  function addBadges(row) {
    const link = row.querySelector('a[data-testid="listitem-title-link"]');
    const titleContainer = link?.closest("h3")?.parentElement;
    if (!titleContainer) return;

    const prPath = new URL(link.href).pathname;
    if (!/^\/[^/]+\/[^/]+\/pull\/\d+$/.test(prPath)) return;
    const existing = titleContainer.querySelector(":scope > .prb-group");
    if (existing?.dataset.prPath === prPath) {
      // GitHub can redraw the right-hand column on its own, which drops the review counts.
      if (existing.prbInfo && !row.querySelector(".prb-reviews"))
        renderReviews(row, existing.prbInfo, existing.prbThreads);
      return;
    }
    existing?.remove();

    ensureStyles();
    reviewSlot(row);
    const group = document.createElement("span");
    group.className = "prb-group";
    group.dataset.prPath = prPath;
    showLoading(group);
    // Floated, so it has to come before the h3 to sit on the title's first line.
    titleContainer.prepend(group);
    loadRow(group, row, {});
  }

  function showLoading(group) {
    const loading = pill(
      "prb-loading",
      "",
      "Loading merge state and line counts",
    );
    const spinner = document.createElement("span");
    spinner.className = "prb-spinner";
    loading.appendChild(spinner);
    group.replaceChildren(loading);
  }

  // Threads load after the main badges so they never hold up a row.
  function loadRow(group, row, { fresh = false, threads = true }) {
    const prPath = group.dataset.prPath;
    return getPrInfo(prPath, { fresh }).then(
      (info) => {
        if (!renderFetched(group, row, info, threads)) return;
        if (!threads || !isOpen(info) || !wantsWaitingThreads(row)) return;
        loadThreads(group, row, info, { fresh });
      },
      (error) => showFailure(group, error),
    );
  }

  function loadThreads(group, row, info, { fresh }) {
    getWaitingThreads(group.dataset.prPath, { fresh }).then(
      (result) => {
        group.prbThreads = result;
        renderReviews(row, group.prbInfo ?? info, result);
      },
      (error) => showFailure(group, error),
    );
  }

  // A request that was in flight when a feature was turned on comes back without that feature's data.
  function renderFetched(group, row, info, threads = true) {
    if (needsRefetch(info)) {
      loadRow(group, row, { fresh: true, threads });
      return false;
    }
    renderBadges(group, row, info);
    return true;
  }

  function renderBadges(group, row, info) {
    const size = shows(info, "lineCounts") ? [sizePill(info)] : [];
    group.replaceChildren(...statePills(info, isApproved(row)), ...size);
    group.prbInfo = info;
    renderReviews(row, info, group.prbThreads);
    group.dataset.checking = isUnresolved(info) ? "true" : "false";
    if (group.dataset.failed) {
      delete group.dataset.failed;
      updateStatus();
    }
  }

  function showFailure(group, error) {
    group.dataset.failed = failureReason(error);
    group.querySelector(".prb-error")?.remove();
    if (!group.prbInfo) group.replaceChildren();
    group.prepend(errorMark(group.dataset.failed));
    updateStatus();
  }

  function refreshRow(group, { spinner = false, threads = true } = {}) {
    const row = group.closest("li");
    if (!row) return;
    if (spinner && !group.prbInfo) showLoading(group);
    loadRow(group, row, { fresh: true, threads });
  }

  let lastCheckingRefresh = Date.now();
  function refreshCheckingRows() {
    if (document.visibilityState !== "visible" || !isPrListPage()) return;
    if (rateLimited) return;
    lastCheckingRefresh = Date.now();
    // Current badges stay up until fresh data replaces them, and stay put if a refetch fails.
    document
      .querySelectorAll('.prb-group[data-checking="true"]')
      .forEach((group) => {
        const row = group.closest("li");
        getPrInfo(group.dataset.prPath, { fresh: true }).then(
          (info) => renderFetched(group, row, info, false),
          (error) => {
            if (error.rateLimited || error.skipped) showFailure(group, error);
          },
        );
      });
  }

  // Opening a PR from the list is a full page load, and Back can restore the frozen list from the
  // browser's back-forward cache without rerunning anything, so refresh the PRs opened from here.
  const openedPrs = new Set();
  document.addEventListener(
    "click",
    (event) => {
      const link = event.target.closest?.(
        'a[data-testid="listitem-title-link"]',
      );
      if (link) openedPrs.add(new URL(link.href).pathname);
    },
    true,
  );
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted || !isPrListPage() || rateLimited) return;
    document.querySelectorAll(".prb-group").forEach((group) => {
      if (openedPrs.has(group.dataset.prPath)) refreshRow(group);
    });
    openedPrs.clear();
  });

  // Runs on all of github.com because GitHub navigates between pages without a full reload.
  function isPrListPage() {
    return (
      /^\/pulls(\/|$)/.test(location.pathname) ||
      /^\/[^/]+\/[^/]+\/pulls(\/|$)/.test(location.pathname)
    );
  }

  function highlight() {
    if (!isPrListPage()) return;

    // Old experience: rows identified by [data-id]
    document.querySelectorAll("[data-id]").forEach((row) => {
      const timeEl = row.querySelector("relative-time, time");
      if (timeEl) applyHighlight(row, timeEl);
    });

    // New preview experience: rows are <li> ancestors of the timestamp container.
    // We use the first relative-time in the container, which is the "opened" date.
    document
      .querySelectorAll('[data-testid="timestamp-container"]')
      .forEach((container) => {
        const timeEl = container.querySelector("relative-time");
        if (!timeEl) return;
        const row = container.closest("li");
        if (!row) return;
        applyHighlight(row, timeEl);
        applyAuthorHighlight(row);
        addBadges(row);
      });
    addFooter();
    // Runs on every DOM change, so the author list rebuilds only when the page's authors change.
    if (renderedAuthors !== authorSignature()) renderPanel();
  }

  let highlightQueued = false;
  function queueHighlight() {
    if (highlightQueued) return;
    highlightQueued = true;
    requestAnimationFrame(() => {
      highlightQueued = false;
      highlight();
    });
  }

  // Keeps other open GitHub tabs in step when settings change in one of them.
  window.addEventListener("storage", (event) => {
    if (event.key !== SETTINGS_KEY) return;
    const before = JSON.stringify(settings.features);
    settings = loadSettings();
    applySettings({ features: JSON.stringify(settings.features) !== before });
  });

  highlight();
  new MutationObserver(queueHighlight).observe(document.body, {
    childList: true,
    subtree: true,
  });
  if (CONFIG.checkingRefreshSeconds > 0) {
    setInterval(refreshCheckingRows, CONFIG.checkingRefreshSeconds * 1000);
    document.addEventListener("visibilitychange", () => {
      const overdue =
        Date.now() - lastCheckingRefresh >=
        CONFIG.checkingRefreshSeconds * 1000;
      if (overdue) refreshCheckingRows();
    });
  }
})();
