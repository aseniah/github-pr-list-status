// ==UserScript==
// @name        GitHub PR List Status
// @namespace   https://github.com/aseniah
// @description Colors PRs by age and approval, and adds merge state and line count badges to the pull requests list
// @version     1.7.2
// @license     MIT
// @updateURL   https://raw.githubusercontent.com/aseniah/github-pr-list-status/main/github-pr-list-status.user.js
// @downloadURL https://raw.githubusercontent.com/aseniah/github-pr-list-status/main/github-pr-list-status.user.js
// @match       https://github.com/*
// @run-at      document-idle
// @inject-into content
// ==/UserScript==

(() => {
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
    doneColor: "var(--bgColor-neutral-muted, #818b981f)", // merged or closed: gray

    // A failing check matching one of these gets its own badge instead of counting toward "N failing".
    // match: exact check name or a RegExp. style: purple, blue, red, yellow, gray, or green.
    namedChecks: [
      { match: "Release Check", label: "🔒 Pipeline", style: "purple" },
    ],

    // People matching these are left out of the review counts. match: exact login or a RegExp.
    ignoredReviewers: [/\[bot\]$/i, /^copilot/i],

    // Leave lockfiles out of the line counts so dependency upgrades show the reviewable size.
    // The exclude* settings and flagWaitingThreads are defaults. Choices made in the settings panel take precedence.
    // A file matching more than one pattern counts toward the first that's on: lockfiles, generated, tests, then docs.
    excludeLockfiles: true,
    lockfilePattern:
      /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Gemfile\.lock|Cargo\.lock|composer\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|go\.sum|flake\.lock)$/,
    // Generated code, matched only by names its tools always use: protobuf, minified bundles, and output folders.
    excludeGenerated: true,
    generatedPattern:
      /(^|\/)(generated|__generated__|dist)\/|\.pb\.[^/]+$|_(grpc_)?pb\.(js|ts|d\.ts)$|\.generated\.[^/]+$|_pb2(_grpc)?\.pyi?$|\.min\.(js|css)$|\.(js|css)\.map$|(^|\/)zz_generated\.[^/]+$|\.(g|freezed)\.dart$|\.[Dd]esigner\.cs$/,
    // Leave tests, mocks, fixtures, and snapshots out too, so the count reflects the change under test.
    excludeTests: true,
    testPattern:
      /(^|\/)(__tests__|__mocks__|__snapshots__|__fixtures__|tests?|spec|e2e|cypress|mocks?|fixtures|testdata|androidTest|testFixtures|[\w.]*Tests)\/|[._](test|spec)\.(?!(json|ya?ml|md|txt)$)[^/]+$|\.e2e-spec\.[^/]+$|\.cy\.[^/]+$|(^|\/)(test_[^/]*\.py|tests\.py|conftest\.py)$|\w(Tests?|Spec)\.(java|kt|swift|cs|scala|groovy)$|\.snap$/,
    // Docs, currently Markdown, which includes READMEs and agent instruction files.
    excludeDocs: true,
    docsPattern: /\.(md|mdx|markdown)$/i,

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
      key: "ticketGroups",
      label: "Related tickets",
      description:
        "Colors ticket keys shared by PRs on the page and links each key to a search for related PRs. No requests.",
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
      description:
        "Lists every file in the PR, so it costs more on large PRs. The Leave out options share that list.",
      parent: "lineCounts",
      default: CONFIG.excludeLockfiles,
    },
    {
      key: "excludeGenerated",
      label: "Leave out generated files",
      description:
        "Protobuf output, minified bundles, and generated or dist folders.",
      parent: "lineCounts",
      default: CONFIG.excludeGenerated,
    },
    {
      key: "excludeTests",
      label: "Leave out tests",
      description: "Tests, mocks, fixtures, and snapshots.",
      parent: "lineCounts",
      default: CONFIG.excludeTests,
    },
    {
      key: "excludeDocs",
      label: "Leave out docs",
      description: "Markdown, including READMEs and agent instructions.",
      parent: "lineCounts",
      default: CONFIG.excludeDocs,
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
    {
      key: "celebration",
      label: "Celebrate an empty PR list 🎉",
      description: "A surprise when no PRs are waiting on your review.",
      default: true,
    },
  ];
  const FEWER_REQUESTS_OFF = new Set([
    "checks",
    "excludeLockfiles",
    "excludeGenerated",
    "excludeTests",
    "excludeDocs",
    "commenters",
    "waitingThreads",
  ]);
  // In match order. noun names the skipped lines in the tooltip, and plural names the files in the legend.
  const LINE_FILTERS = [
    {
      key: "excludeLockfiles",
      pattern: CONFIG.lockfilePattern,
      noun: "lockfile",
      plural: "lockfiles",
    },
    {
      key: "excludeGenerated",
      pattern: CONFIG.generatedPattern,
      noun: "generated",
      plural: "generated files",
    },
    {
      key: "excludeTests",
      pattern: CONFIG.testPattern,
      noun: "test",
      plural: "tests",
    },
    {
      key: "excludeDocs",
      pattern: CONFIG.docsPattern,
      noun: "doc",
      plural: "docs",
    },
  ];
  const LINE_FILTER_KEYS = LINE_FILTERS.map((f) => f.key);
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
        !LINE_FILTER_KEYS.includes(f.key) &&
        f.key !== "ticketGroups" &&
        f.key !== "celebration" &&
        settings.features[f.key] &&
        !info.features?.[f.key],
    );
    // Line groups cover every filter, so only a PR counted without the file list needs it fetched.
    const needsFileList =
      isOn("lineCounts") && LINE_FILTER_KEYS.some(isOn) && !info.lineGroups;
    return missing || needsFileList;
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
    :root { --prb-row-yellow: #fff8c5; --prb-row-orange: #ffd8b1; --prb-row-red: #ffd0d0; --prb-row-green: #c8f5c8; --prb-hl-solid: #6e7781; --prb-tg-0: #0969da; --prb-tg-1: #8250df; --prb-tg-2: #bf3989; --prb-tg-3: #1b7c83; --prb-tg-4: #bc4c00; --prb-tg-5: #6e7781; --prb-draft-stripe: rgba(31, 35, 40, 0.05); }
    [data-color-mode="dark"] { --prb-row-yellow: #2f2a05; --prb-row-orange: #3d1f0d; --prb-row-red: #3c0614; --prb-row-green: #122117; --prb-hl-solid: #6e7681; --prb-tg-0: #4493f8; --prb-tg-1: #ab7df8; --prb-tg-2: #db61a2; --prb-tg-3: #39c5cf; --prb-tg-4: #db6d28; --prb-tg-5: #9198a1; --prb-draft-stripe: rgba(240, 246, 252, 0.05); }
    @media (prefers-color-scheme: dark) {
      [data-color-mode="auto"] { --prb-row-yellow: #2f2a05; --prb-row-orange: #3d1f0d; --prb-row-red: #3c0614; --prb-row-green: #122117; --prb-hl-solid: #6e7681; --prb-tg-0: #4493f8; --prb-tg-1: #ab7df8; --prb-tg-2: #db61a2; --prb-tg-3: #39c5cf; --prb-tg-4: #db6d28; --prb-tg-5: #9198a1; --prb-draft-stripe: rgba(240, 246, 252, 0.05); }
    }
    .prb-group { float: right; display: inline-flex; gap: 6px; margin: 2px 16px 0 12px; }
    .prb { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 500; line-height: 18px; padding: 0 7px; border-radius: 2em; border: 1px solid transparent; white-space: nowrap; }
    .prb-size { background: var(--bgColor-default, #fff); border-color: var(--borderColor-default, #d1d9e0); color: var(--fgColor-muted, #59636e); font-variant-numeric: tabular-nums; }
    .prb-size .add { color: var(--fgColor-success, #1a7f37); }
    .prb-size .del { color: var(--fgColor-danger, #d1242f); }
    .prb[data-prb-tip], .prb-review-counts [data-prb-tip] { cursor: default; }
    .prb-size.prb-trimmed { border-style: dashed; border-color: var(--fgColor-muted, #59636e); }
    .prb-bubble { display: none; position: absolute; z-index: 100; max-width: 260px; padding: 6px 8px; border: 1px solid var(--borderColor-default, #d1d9e0); border-radius: 6px; background: var(--bgColor-default, #fff); box-shadow: 0 8px 24px rgba(37, 41, 46, 0.12); color: var(--fgColor-default, #1f2328); font-size: 12px; font-weight: 400; line-height: 18px; white-space: pre-line; pointer-events: none; }
    .prb-ready    { background: var(--bgColor-success-emphasis, #1a7f37); color: var(--fgColor-onEmphasis, #fff); }
    .prb-behind   { background: var(--bgColor-attention-muted, #fff8c5); border-color: var(--borderColor-attention-emphasis, #d4a72c); color: var(--fgColor-attention, #9a6700); }
    .prb-conflict, .prb-failing { background: var(--bgColor-danger-muted, #ffebe9); border-color: var(--borderColor-danger-muted, #ff818266); color: var(--fgColor-danger, #d1242f); }
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
    .prb-review-counts .waiting { color: var(--fgColor-accent, #0969da); font-weight: 600; }
    .prb-review-counts :is(.rereq, .waiting) svg { width: 16px; height: 16px; }
    .prb-review-counts :is(.rereq, .waiting) circle { fill: var(--bgColor-accent-emphasis, #0969da); }
    .prb-review-counts :is(.rereq, .waiting) path { fill: var(--fgColor-onEmphasis, #fff); }
    .prb-error { color: var(--fgColor-muted, #59636e); font-size: 14px; line-height: 18px; cursor: help; }
    .prb-status { margin-left: auto; text-align: right; font-size: 12px; color: var(--fgColor-attention, #9a6700); }
    .prb-status:empty { display: none; }
    .prb-status > span { cursor: help; }
    .prb-status button { margin-left: 4px; padding: 0; border: 0; background: none; font: inherit; color: var(--fgColor-accent, #0969da); cursor: pointer; }
    .prb-status button:hover { text-decoration: underline; }
    .prb-legend { margin-top: 8px; border: 1px solid var(--borderColor-default, #d1d9e0); border-radius: 6px; font-size: 12px; color: var(--fgColor-muted, #59636e); }
    .prb-legend-body { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 16px 48px; padding: 12px 16px 16px; }
    .prb-legend-body > div { flex: 0 0 auto; }
    .prb-legend-body > div:nth-child(2) { flex: 1 1 0; min-width: 240px; }
    .prb-legend h4 { margin: 0 0 8px; font-size: 12px; font-weight: 600; color: var(--fgColor-default, #1f2328); }
    .prb-legend dl { display: grid; grid-template-columns: max-content 1fr; gap: 8px 12px; align-items: start; margin: 0; }
    .prb-legend dt { display: flex; align-items: center; justify-content: flex-end; min-height: 20px; }
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
    .prb-tg-0 { --prb-tg: var(--prb-tg-0); } .prb-tg-1 { --prb-tg: var(--prb-tg-1); } .prb-tg-2 { --prb-tg: var(--prb-tg-2); }
    .prb-tg-3 { --prb-tg: var(--prb-tg-3); } .prb-tg-4 { --prb-tg: var(--prb-tg-4); } .prb-tg-5 { --prb-tg: var(--prb-tg-5); }
    .prb-ticket { display: inline-flex; align-items: center; margin-right: 6px; padding: 0 7px; border: 1px solid var(--prb-tg); border-radius: 2em; background: color-mix(in srgb, var(--prb-tg) 14%, var(--bgColor-default, #fff)); color: var(--prb-tg); font-size: 12px; font-weight: 600; line-height: 18px; vertical-align: 2px; white-space: nowrap; text-decoration: none; cursor: pointer; }
    .prb-ticket:hover { text-decoration: underline; }
    .prb-ticket.prb-ticket-single { --prb-tg: var(--fgColor-muted, #59636e); background: var(--bgColor-default, #fff); }
    .prb-legend .prb-ticket { margin-right: 0; }
    /* A 45° tile holds two stripe periods of 6px stripes and 10px gaps, so its side is 16px × √2. */
    .prb-draft { background-image: linear-gradient(45deg, var(--prb-draft-stripe) 0 18.75%, transparent 18.75% 50%, var(--prb-draft-stripe) 50% 68.75%, transparent 68.75% 100%); background-size: 22.627px 22.627px; background-origin: border-box; }
    .prb-tg-dim > li { transition: opacity 0.12s; }
    .prb-tg-dim > li:not(.prb-tg-hot) { opacity: 0.4; }
    .prb-tg-arrow { position: fixed; left: 50%; z-index: 100; display: inline-flex; align-items: center; padding: 4px 12px; border: 1px solid var(--prb-tg); border-radius: 2em; background: var(--bgColor-default, #fff); color: var(--prb-tg); font: inherit; font-size: 12px; font-weight: 600; box-shadow: 0 4px 12px rgba(37, 41, 46, 0.18); pointer-events: none; animation: prb-tg-bounce 1.2s ease-in-out infinite; }
    .prb-tg-arrow[hidden] { display: none; }
    .prb-tg-arrow.up { top: 12px; --prb-dir: -1; }
    /* Sits above the link preview browsers draw at the bottom of the window. */
    .prb-tg-arrow.down { bottom: 48px; --prb-dir: 1; }
    @keyframes prb-tg-bounce { 0%, 100% { transform: translate(-50%, 0); } 50% { transform: translate(-50%, calc(var(--prb-dir) * 4px)); } }
    @media (prefers-reduced-motion: reduce) { .prb-tg-arrow { animation: none; transform: translateX(-50%); } }
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

  // GitHub inserts the review decision a few seconds after the rows, which reruns highlight().
  function isApproved(row) {
    return !!row
      .querySelector('[data-testid="review-decision-icon"]')
      ?.textContent.includes("Approved");
  }

  // The row's first icon is its state: open, draft, merged, or closed.
  function isDone(row) {
    const icon = row.querySelector("svg");
    return (
      !!icon?.classList.contains("octicon-git-merge") ||
      !!icon?.classList.contains("octicon-git-pull-request-closed")
    );
  }

  function isDraft(row) {
    return !!row
      .querySelector("svg")
      ?.classList.contains("octicon-git-pull-request-draft");
  }

  function applyHighlight(row, timeEl) {
    const datetime = timeEl.getAttribute("datetime");
    if (!datetime) return;
    const draft = isOn("rowColors") && isDraft(row);
    if (row.classList.contains("prb-draft") !== draft)
      row.classList.toggle("prb-draft", draft);
    if (!isOn("rowColors")) {
      row.style.backgroundColor = "";
      return;
    }

    const color = isDone(row)
      ? CONFIG.doneColor
      : isApproved(row)
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

  // lineGroups is null without the file list, and empty when file_tree listed no files.
  async function loadLineCounts(prPath, features) {
    const filtering = LINE_FILTER_KEYS.some((key) => features[key]);
    if (filtering) {
      const tree = await fetchPageData(prPath, "file_tree");
      if (tree.diffs?.length) return groupLines(tree.diffs);
    }
    const { diffstat } = await fetchPageData(prPath, "diffstat");
    return {
      linesAdded: diffstat.linesAdded,
      linesDeleted: diffstat.linesDeleted,
      lineGroups: filtering ? [] : null,
    };
  }

  // Files are grouped by which patterns they match, so toggling filters later needs no new request.
  function groupLines(diffs) {
    const counts = { linesAdded: 0, linesDeleted: 0 };
    const byMask = new Map();
    // file_tree leaves out count fields that are zero.
    diffs.forEach(({ path, linesAdded = 0, linesDeleted = 0 }) => {
      counts.linesAdded += linesAdded;
      counts.linesDeleted += linesDeleted;
      const mask = LINE_FILTERS.reduce(
        (bits, f, i) => (f.pattern.test(path) ? bits | (1 << i) : bits),
        0,
      );
      if (!mask) return;
      const group = byMask.get(mask) || { mask, added: 0, deleted: 0 };
      group.added += linesAdded;
      group.deleted += linesDeleted;
      byMask.set(mask, group);
    });
    return { ...counts, lineGroups: [...byMask.values()] };
  }

  // A file counts toward the first filter it matches among those that are on.
  function shownLines(info) {
    const counts = {
      linesAdded: info.linesAdded,
      linesDeleted: info.linesDeleted,
      skippedLines: {},
    };
    (info.lineGroups || []).forEach(({ mask, added, deleted }) => {
      const filter = LINE_FILTERS.find(
        (f, i) => mask & (1 << i) && isOn(f.key),
      );
      if (!filter) return;
      counts.linesAdded -= added;
      counts.linesDeleted -= deleted;
      counts.skippedLines[filter.key] =
        (counts.skippedLines[filter.key] || 0) + added + deleted;
    });
    return counts;
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
      features.lineCounts ? loadLineCounts(prPath, features) : null,
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
    cache.forEach((old, path) => {
      if (Date.now() - old.at >= CACHE_TTL_MS) cache.delete(path);
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
    if (tooltip) setTip(el, tooltip);
    return el;
  }

  function setTip(el, tip) {
    el.dataset.prbTip = tip;
    el.setAttribute("aria-description", tip);
  }

  function sizeLegend() {
    const left = LINE_FILTERS.filter((f) => isOn(f.key)).map((f) => f.plural);
    return left.length
      ? `Lines added and deleted, not counting ${listOf(left, "or")}`
      : "Lines added and deleted";
  }

  function listOf(items, conjunction) {
    if (items.length < 3) return items.join(` ${conjunction} `);
    return `${items.slice(0, -1).join(", ")}, ${conjunction} ${items.at(-1)}`;
  }

  function sizePill(info) {
    const counts = LINE_FILTERS.filter((f) => info.skippedLines?.[f.key]).map(
      (f) => [info.skippedLines[f.key], f.noun],
    );
    const skipped = counts.map(([n, noun]) => `${n} ${noun}`);
    const line = counts.length === 1 && counts[0][0] === 1 ? "line" : "lines";
    const excluded = skipped.length
      ? `\n${listOf(skipped, "and")} ${line} not counted`
      : "";
    const el = pill(
      skipped.length ? "prb-size prb-trimmed" : "prb-size",
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

  // PRs opened with Copilot show the person as the attributed author, "jdoe with Copilot".
  const AUTHOR_LINKS =
    '[data-testid="attributed-author-filter-link"], [data-testid="author-filter-link"]';

  // "Filter by author Full Name (login)", or just the login when there's no display name.
  function rowAuthors(row) {
    return [...row.querySelectorAll(AUTHOR_LINKS)]
      .map((link) => {
        const label = (link.getAttribute("aria-label") || "")
          .replace(/^Filter by author\s+/, "")
          .trim();
        const login = label.match(/\(([^)]+)\)\s*$/)?.[1] ?? label;
        return { link, label, login };
      })
      .filter((author) => author.login);
  }

  function prAuthors(row) {
    return rowAuthors(row).map((author) => author.login);
  }

  // Approvals and change requests come from each reviewer's latest decision. Anyone else who joined
  // the conversation, other than the author and ignored accounts, counts as a commenter.
  function reviewSummary(info, row) {
    const ignored = (login) =>
      CONFIG.ignoredReviewers.some((m) => checkMatches(m, login));
    const approved = info.approvedBy.filter((l) => !ignored(l));
    const changes = info.changesRequestedBy.filter((l) => !ignored(l));
    const decided = new Set([...approved, ...changes, ...prAuthors(row)]);
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
      prAuthors(row).includes(viewerLogin()) &&
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

  const SVG_NS = "http://www.w3.org/2000/svg";
  function svgNode(tag, attrs = {}, ...children) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs))
      node.setAttribute(name, value);
    node.append(...children);
    return node;
  }

  function octicon(iconPath) {
    return svgNode(
      "svg",
      { viewBox: "0 0 16 16", "aria-hidden": "true" },
      svgNode("path", { d: iconPath }),
    );
  }

  // Every row gets the second line, even when empty, so the comment count always sits level with the
  // title and the column keeps one width down the list.
  function reviewSlot(row) {
    const metadata =
      row.querySelector(":scope > .prb-meta-stack") ??
      [...row.children].find((el) =>
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
    slot.replaceChildren(el);
    if (waiting) {
      const badge = waitingBadge(threads.waiting);
      setTip(badge, waitingTooltip(threads));
      el.append(badge);
    }
    if (reRequested) {
      const icon = reRequestIcon();
      setTip(icon, "Your review was re-requested");
      el.append(icon);
    }
    el.append(
      ...parts.map((part) => {
        const count = document.createElement("span");
        count.className = part.className;
        count.append(part.icon ?? discussionIcon(), String(part.people.length));
        setTip(count, `${part.label}: ${part.people.join(", ")}`);
        return count;
      }),
    );
  }

  function injectStyles(id, css) {
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = css;
    document.head.appendChild(style);
  }

  function ensureStyles() {
    injectStyles("prb-styles", BADGE_CSS);
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
    const draftSwatch = () =>
      element("span", { className: "prb-legend-swatch prb-draft" });
    const reviewCount = (className, icon) => {
      const counts = document.createElement("span");
      counts.className = "prb-review-counts";
      const count = document.createElement("span");
      count.className = className;
      count.append(icon, "2");
      counts.append(count);
      return counts;
    };
    const sizeSample = (info) => {
      const el = sizePill({ linesAdded: 96, linesDeleted: 12, ...info });
      delete el.dataset.prbTip;
      el.removeAttribute("aria-description");
      return el;
    };
    const trimmed = LINE_FILTER_KEYS.some(isOn)
      ? [
          [
            sizeSample({ skippedLines: { excludeTests: 1 } }),
            "Dashed when files were left out. Hover for how many lines.",
          ],
        ]
      : [];

    const rowColors = [
      [swatch(CONFIG.approvedColor), "Approved"],
      ...CONFIG.ageColors.map((t, i) => [
        swatch(t.color),
        `Not approved, ${ageRangeLabel(CONFIG.ageColors[i - 1]?.days, t.days)} old`,
      ]),
      [swatch(CONFIG.doneColor), "Merged or closed"],
      [draftSwatch(), "Draft, striped over its age or approval color"],
    ];
    const ticketSample = (className) =>
      element("span", { className, textContent: "ABC-123" });
    const tickets = isOn("ticketGroups")
      ? [
          [
            ticketSample("prb-ticket prb-tg-0"),
            "A ticket key: other PRs on this page share it. Hover to find them, click to search every PR that mentions it.",
          ],
          [
            ticketSample("prb-ticket prb-ticket-single"),
            "A ticket key: only this PR on the page has it. Click to search for related PRs.",
          ],
        ]
      : [];
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
      [sizeSample(), sizeLegend()],
      ...trimmed,
      [errorMark(), "Some details didn't load. Hover for why."],
      [authorChip("John Doe (jdoe)"), "An author you chose to highlight"],
      ...tickets,
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
    rowAuthors(row).forEach(({ link, login }) => {
      const highlighted = settings.authors.has(login.toLowerCase());
      const wanted = highlighted ? ["prb-hl", `prb-hl-${settings.style}`] : [];
      ["prb-hl", ...HIGHLIGHT_STYLES.map((s) => `prb-hl-${s}`)].forEach(
        (name) => {
          const on = wanted.includes(name);
          if (link.classList.contains(name) !== on)
            link.classList.toggle(name, on);
        },
      );
    });
  }

  function listRows() {
    return [...document.querySelectorAll('[data-testid="timestamp-container"]')]
      .map((container) => container.closest("li"))
      .filter(Boolean);
  }

  function pageAuthors(rows = listRows()) {
    const authors = new Map();
    rows.forEach((row) => {
      rowAuthors(row).forEach(({ login, label }) => {
        const key = login.toLowerCase();
        if (!authors.has(key)) authors.set(key, label);
      });
    });
    return authors;
  }

  function authorSignature(rows) {
    return [...pageAuthors(rows)].join("|");
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
      body.querySelector(`[data-prb-focus="${CSS.escape(focused)}"]`)?.focus();
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
    // An empty list has no rows, but its empty state sits in the same list, so the panel stays reachable.
    const list = document
      .querySelector(
        '[data-testid="timestamp-container"], [data-component="Blankslate"]',
      )
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
      setTip(
        el,
        `PR List Status couldn't load all of this PR's details. ${reason}.`,
      );
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

  // The title's inline heading is an h3 on some lists and an h4 on others, such as repo and search lists.
  function titleHeading(link) {
    return link?.closest("h1, h2, h3, h4, h5, h6");
  }

  function addBadges(row) {
    const link = row.querySelector('a[data-testid="listitem-title-link"]');
    const titleContainer = titleHeading(link)?.parentElement;
    if (!titleContainer) return;

    const prPath = link.pathname;
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
    // Floated, so it has to come before the heading to sit on the title's first line.
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
    const size = shows(info, "lineCounts") ? [sizePill(shownLines(info))] : [];
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

  // Matches PAY-2210, pay_2210, and Feature/pay 2210. A space needs 3+ digits so "Node 22" doesn't count.
  // A second number part, as in CVE-2024-1234 or ubuntu-22.04, rules the match out. Underscores
  // around the key are allowed, so the edges are lookarounds rather than \b.
  const TICKET_PATTERN =
    /(?<![a-z0-9])([a-z][a-z0-9]{1,9})([-_ ])(\d{2,})(?![a-z0-9]|[-_.]\d)/gi;
  // Standards like SHA-256 look like keys. They still count, but any other key wins.
  const UNLIKELY_PROJECTS = new Set(["CWE", "ISO", "RFC", "SHA", "UTF"]);
  const TICKET_COLORS = 6;

  // Takes the most key-like match, so "Return 404 for PAY-2210" finds PAY-2210. A key opened by a
  // paren or bracket, as in feat(PAY-2210) or [PAY-2210], wins over the same form without one.
  function findTicket(text) {
    let best = null;
    for (const match of text.matchAll(TICKET_PATTERN)) {
      const [, project, separator, number] = match;
      if (separator === " " && number.length < 3) continue;
      const rank =
        (UNLIKELY_PROJECTS.has(project.toUpperCase()) ? 4 : 0) +
        (separator === " " ? 2 : 0) +
        ("([".includes(text[match.index - 1]) ? 0 : 1);
      if (!best || rank < best.rank)
        best = { key: `${project.toUpperCase()}-${number}`, rank };
    }
    return best;
  }

  function titleLink(row) {
    return row.querySelector('a[data-testid="listitem-title-link"]');
  }

  // The pill sits before the title's heading, outside GitHub's link, so its clicks and hovers are its own.
  function ticketPill(link) {
    const heading = titleHeading(link);
    if (!heading) return null;
    const existing = heading.previousElementSibling;
    if (existing?.classList.contains("prb-ticket")) return existing;
    const el = element("a", { target: "_blank", rel: "noopener" });
    heading.before(el);
    return el;
  }

  function removePill(link) {
    const pill = titleHeading(link)?.previousElementSibling;
    if (pill?.classList.contains("prb-ticket")) pill.remove();
  }

  // Keys shared by several rows get a color, in order of first appearance. Single keys stay neutral.
  function applyTicketKeys(rowElements) {
    const rows = rowElements.map((row) => {
      const link = titleLink(row);
      return {
        row,
        link,
        key:
          isOn("ticketGroups") && link
            ? findTicket(link.textContent)?.key
            : null,
      };
    });
    const counts = new Map();
    rows.forEach(
      ({ key }) => key && counts.set(key, (counts.get(key) || 0) + 1),
    );
    const colors = new Map();
    counts.forEach(
      (n, key) => n > 1 && colors.set(key, colors.size % TICKET_COLORS),
    );

    const owners = new Map();
    rows.forEach(({ link, key }) => {
      if (!key) return;
      if (!owners.has(key)) owners.set(key, new Set());
      owners.get(key).add(link.pathname.split("/")[1]);
    });

    rows.forEach(({ row, link, key }) => {
      const shared = key && colors.has(key);
      if (shared && row.dataset.prbTicket !== key) row.dataset.prbTicket = key;
      if (!shared && row.dataset.prbTicket) delete row.dataset.prbTicket;
      if (!key) return removePill(link);
      const el = ticketPill(link);
      if (!el) return;
      const href = ticketSearchUrl(key, owners.get(key));
      if (el.dataset.ticket !== key) el.dataset.ticket = key;
      if (el.textContent !== key) el.textContent = key;
      if (el.href !== href) el.href = href;
      const className = shared
        ? `prb-ticket prb-tg-${colors.get(key)}`
        : "prb-ticket prb-ticket-single";
      const tip = shared
        ? `${counts.get(key)} PRs on this page reference ${key}. Click to search every PR that mentions it.`
        : `The only PR on this page with ${key}. Opens a search for every PR that mentions it.`;
      if (el.className !== className) el.className = className;
      if (el.dataset.prbTip !== tip) setTip(el, tip);
    });
    if (activeTicket.key && !colors.has(activeTicket.key))
      setActiveTicket(null);
  }

  // GitHub search matches "PAY-2210" against "pay 2210", but an underscore joins the token, so it needs its own term.
  function ticketSearchUrl(key, owners) {
    const [project, number] = key.split("-");
    const query = [
      `is:pr ("${key}" OR "${project}_${number}") in:title,body`,
      ...[...owners].map((owner) => `org:${owner}`),
      "sort:updated-desc",
    ].join(" ");
    return `https://github.com/pulls?q=${encodeURIComponent(query)}`;
  }

  // Hovering a shared key dims the other rows. Browsers repeat mouse events at the same clientX/Y after
  // a scroll, so the group stays active while scrolling and ends only when the pointer really moves away.
  const activeTicket = {
    key: null,
    color: "",
    row: null,
    x: -1,
    y: -1,
    anchorX: -1,
    anchorY: -1,
  };
  // Scrolling nudges the pointer, so moves this small change nothing, even onto another pill.
  const TICKET_HOVER_SLACK = 10;
  let ticketArrows = null;

  function groupRows() {
    return listRows().filter(
      (row) => activeTicket.key && row.dataset.prbTicket === activeTicket.key,
    );
  }

  function setActiveTicket(el) {
    const key = el?.dataset.ticket ?? null;
    if (key === activeTicket.key) return;
    activeTicket.key = key;
    activeTicket.row = el?.closest("li") ?? null;
    activeTicket.color = el
      ? getComputedStyle(el).getPropertyValue("--prb-tg").trim()
      : "";
    document
      .querySelectorAll(".prb-tg-dim")
      .forEach((list) => list.classList.remove("prb-tg-dim"));
    document
      .querySelectorAll(".prb-tg-hot")
      .forEach((row) => row.classList.remove("prb-tg-hot"));
    groupRows().forEach((row) => {
      row.classList.add("prb-tg-hot");
      row.parentElement.classList.add("prb-tg-dim");
    });
    updateTicketArrows();
  }

  function createTicketArrows() {
    const arrow = (direction) => {
      const el = element("div", {
        className: `prb-tg-arrow ${direction}`,
        hidden: true,
      });
      el.setAttribute("aria-hidden", "true");
      document.body.append(el);
      return el;
    };
    return { up: arrow("up"), down: arrow("down") };
  }

  // Runs on every scrolled frame while a key is hovered, so only write what changed.
  function setArrow(arrow, count, symbol) {
    if (arrow.hidden !== !count) arrow.hidden = !count;
    if (!count) return;
    const text = `${symbol} ${count} more ${activeTicket.key}`;
    if (arrow.textContent !== text) arrow.textContent = text;
    if (arrow.style.getPropertyValue("--prb-tg") !== activeTicket.color)
      arrow.style.setProperty("--prb-tg", activeTicket.color);
  }

  function updateTicketArrows() {
    if (!activeTicket.key && !ticketArrows) return;
    ensureStyles();
    ticketArrows ||= createTicketArrows();
    // Any related row not fully in view counts. The hovered row counts only once scrolled fully away.
    const rects = groupRows().map((row) => [row, row.getBoundingClientRect()]);
    const counted = rects.filter(
      ([row, rect]) =>
        row !== activeTicket.row || rect.bottom <= 0 || rect.top >= innerHeight,
    );
    const above = counted.filter(([, rect]) => rect.top < 0);
    const below = counted.filter(([, rect]) => rect.bottom > innerHeight);
    setArrow(ticketArrows.up, above.length, "↑");
    setArrow(ticketArrows.down, below.length, "↓");
  }

  document.addEventListener(
    "mousemove",
    (event) => {
      if (event.clientX === activeTicket.x && event.clientY === activeTicket.y)
        return;
      activeTicket.x = event.clientX;
      activeTicket.y = event.clientY;
      if (
        activeTicket.key &&
        Math.hypot(
          event.clientX - activeTicket.anchorX,
          event.clientY - activeTicket.anchorY,
        ) <= TICKET_HOVER_SLACK
      )
        return;
      const el = event.target.closest?.(
        ".prb-ticket[data-ticket]:not(.prb-ticket-single)",
      );
      if (el) {
        activeTicket.anchorX = event.clientX;
        activeTicket.anchorY = event.clientY;
        setActiveTicket(el);
      } else if (activeTicket.key) setActiveTicket(null);
    },
    { passive: true },
  );
  let arrowsQueued = false;
  function queueTicketArrows() {
    if (!activeTicket.key || arrowsQueued) return;
    arrowsQueued = true;
    requestAnimationFrame(() => {
      arrowsQueued = false;
      if (activeTicket.key) updateTicketArrows();
    });
  }
  window.addEventListener("scroll", queueTicketArrows, { passive: true });
  window.addEventListener("resize", queueTicketArrows);

  // Opening a PR from the list is a full page load, and Back can restore the frozen list from the
  // browser's back-forward cache without rerunning anything, so refresh the PRs opened from here.
  const openedPrs = new Set();
  document.addEventListener(
    "click",
    (event) => {
      const link = event.target.closest?.(
        'a[data-testid="listitem-title-link"]',
      );
      if (link) openedPrs.add(link.pathname);
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

  // One bubble serves every pill and review count, appearing at once where a title would wait a second.
  // It opens on the side of the row its pill is nearest, so the row's own details stay readable.
  let bubble;
  let bubbleTarget = null;
  function showBubble(target) {
    if (target === bubbleTarget) return;
    bubbleTarget = target;
    if (!bubble) {
      bubble = element("div", { id: "prb-bubble", className: "prb-bubble" });
      bubble.setAttribute("role", "tooltip");
      document.body.append(bubble);
    }
    bubble.textContent = target.dataset.prbTip;
    // An absolute box shrinks to fit right of its old left, so measure it from the edge.
    bubble.style.left = bubble.style.top = "0px";
    bubble.style.display = "block";
    const { clientWidth, clientHeight } = document.documentElement;
    const pill = target.getBoundingClientRect();
    const box = bubble.getBoundingClientRect();
    const row = target.closest("li")?.getBoundingClientRect();
    const left = Math.min(
      Math.max(8, pill.left + pill.width / 2 - box.width / 2),
      clientWidth - box.width - 8,
    );
    const fitsAbove = pill.top - 6 - box.height >= 0;
    const fitsBelow = pill.bottom + 6 + box.height <= clientHeight;
    const prefersAbove = !row || pill.top + pill.bottom < row.top + row.bottom;
    const above = prefersAbove
      ? fitsAbove || !fitsBelow
      : !fitsBelow && fitsAbove;
    bubble.style.left = `${left + scrollX}px`;
    bubble.style.top = `${(above ? pill.top - 6 - box.height : pill.bottom + 6) + scrollY}px`;
  }
  function hideBubble() {
    bubbleTarget = null;
    if (bubble) bubble.style.display = "none";
  }
  // Hiding on any other mouseover also covers a pill replaced by a refresh while hovered.
  ["mouseover", "focusin"].forEach((type) =>
    document.addEventListener(type, (event) => {
      const target = event.target.closest?.("[data-prb-tip]");
      if (target) showBubble(target);
      else hideBubble();
    }),
  );
  document.addEventListener("focusout", hideBubble);
  document.addEventListener("mouseout", (event) => {
    if (!event.relatedTarget) hideBubble();
  });
  window.addEventListener("blur", hideBubble);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideBubble();
  });
  window.addEventListener("scroll", hideBubble, { passive: true });

  // ---------- Empty list celebration ----------
  // When a list of PRs waiting on the viewer comes back empty, a small looping animation takes the
  // place of GitHub's "No pull requests matched your search". Each visit picks one effect at random,
  // dressed for the season. Everything runs on CSS transforms and opacity plus a few timers, and
  // stops itself once the element leaves the page.

  const PULL_REQUEST_ICON_PATH =
    "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z";

  // Inclusive [month, day] ranges. Dates outside all of them get the base versions.
  const CELEBRATION_SEASONS = [
    ["halloween", [10, 1], [10, 31]],
    ["thanksgiving", [11, 1], [11, 30]],
    ["winter", [12, 1], [12, 31]],
    ["newyear", [1, 1], [1, 7]],
    ["valentine", [2, 1], [2, 14]],
    ["stpatrick", [3, 10], [3, 17]],
    ["summer", [6, 21], [8, 31]],
  ];

  function celebrationSeason(date) {
    const day = (date.getMonth() + 1) * 100 + date.getDate();
    const match = CELEBRATION_SEASONS.find(
      ([, [fromMonth, fromDay], [toMonth, toDay]]) =>
        day >= fromMonth * 100 + fromDay && day <= toMonth * 100 + toDay,
    );
    return match ? match[0] : "base";
  }

  // The year being celebrated: this one during the New Year window, otherwise the one coming up.
  function celebratedYear(date) {
    return date.getMonth() === 0 ? date.getFullYear() : date.getFullYear() + 1;
  }

  // An empty result on these means nothing is waiting on you. author:@me alone doesn't count.
  const WAITING_QUALIFIERS = [
    "review-requested",
    "user-review-requested",
    "assignee",
    "involves",
    "mentions",
  ];

  // Token-based, so negated (-assignee:@me) and quoted qualifiers don't count, and any closed or
  // merged state rules the list out.
  function isWaitingQuery(query) {
    const tokens = query.replace(/"[^"]*"/g, " ").split(/\s+/);
    const has = (...wanted) => tokens.some((token) => wanted.includes(token));
    return (
      has("is:open", "state:open") &&
      !has("is:closed", "is:merged", "state:closed") &&
      has(...WAITING_QUALIFIERS.map((name) => `${name}:@me`))
    );
  }

  // Shared colors, so a season looks the same across effects.
  const HUE = {
    gold: "#f5c518",
    amber: "#9a6700",
    orange: "#f0883e",
    rust: "#bc4c00",
    red: "#cf222e",
    coral: "#ff7b72",
    pink: "#e85aad",
    rose: "#ff9ccb",
    purple: "#a371f7",
    violet: "#6639ba",
    blue: "#4493f8",
    teal: "#00b4d8",
    green: "#1a7f37",
    lime: "#3fb950",
    white: "#f6f8fa",
    cream: "#fff8c5",
    ink: "#1f2328",
    slate: "#57606a",
    crust: "#d6a15f",
    bake: "#a8672f",
  };
  const RAINBOW = [
    "#da3633",
    HUE.orange,
    HUE.gold,
    HUE.green,
    "#0969da",
    "#8250df",
  ];

  const GIFT_ROWS = [
    "............",
    "............",
    "............",
    "...rr..rr...",
    "....rrrr....",
    "gggggrrggggg",
    "gggggrrggggg",
    ".GGGGrrGGGG.",
    ".GGGGrrGGGG.",
    ".GGGGrrGGGG.",
    ".GGGGrrGGGG.",
    ".GGGGrrGGGG.",
    ".GGGGrrGGGG.",
  ];
  const GIFT_PAL = { g: "#2da44e", G: HUE.green, r: HUE.red, y: HUE.gold };

  // Pixel art: each string is a row and each character a pixel colored from the palette. Characters
  // missing from the palette are transparent. Effects can swap rows or colors per season.
  const SPRITES = {
    heart: [
      [".pp.pp.", "ppppppp", "ppppppp", ".ppppp.", "..ppp..", "...p..."],
      { p: HUE.pink },
    ],
    pumpkin: [
      [
        "....g....",
        "...g.....",
        ".ooooooo.",
        "ooyoooyoo",
        "ooooooooo",
        "ooyyyyyoo",
        "oooyoyooo",
        ".ooooooo.",
      ],
      { g: HUE.green, o: HUE.orange, y: HUE.gold },
    ],
    pie: [
      [
        ".....ww.....",
        "...cccccc...",
        "..cPPPPPPc..",
        ".cPPPPPPPPc.",
        "cccccccccccc",
        "cCCCCCCCCCCc",
        ".cCCCCCCCCc.",
      ],
      { w: HUE.white, c: HUE.crust, P: "#e07b2a", C: HUE.bake },
    ],
    ornament: [
      [
        "...y...",
        "..yyy..",
        ".rrrrr.",
        "rrwrrrr",
        "rrrrrrr",
        "rrrrrrr",
        ".rrrrr.",
        "..rrr..",
      ],
      { r: HUE.red, y: HUE.gold, w: "#fff" },
    ],
    star: [
      [
        "...y...",
        "...y...",
        "yyyyyyy",
        ".yyyyy.",
        "..yyy..",
        ".yy.yy.",
        "y.....y",
      ],
      { y: HUE.gold },
    ],
    coin: [
      [".yyyy.", "ywyyyd", "ywyyyd", "yyyyyd", ".dddd."],
      { y: HUE.gold, w: HUE.cream, d: HUE.amber },
    ],
    clover: [
      [
        "..gg.gg..",
        ".ggggggg.",
        "..ggggg..",
        "gg..g..gg",
        "ggggggggg",
        ".gg.g.gg.",
        "....g....",
        "...g.....",
      ],
      { g: HUE.green },
    ],
    melon: [
      ["rrrrrrrrr", "grkrrrkrg", ".grrkrrg.", "..ggggg.."],
      { r: "#f85149", k: HUE.ink, g: HUE.green },
    ],
    invader: [
      [
        "..a.....a..",
        "...a...a...",
        "..aaaaaaa..",
        ".aa.aaa.aa.",
        "aaaaaaaaaaa",
        "a.aaaaaaa.a",
        "a.a.....a.a",
        "...aa.aa...",
      ],
      { a: "var(--fgColor-success, #1a7f37)" },
    ],
    ship: [
      ["....a....", "...aaa...", ".aaaaaaa.", "aaaaaaaaa", "aaaaaaaaa"],
      { a: "var(--fgColor-accent, #0969da)" },
    ],
    ghost: [
      [
        "..rrrr..",
        ".rrrrrr.",
        "rwwrrwwr",
        "rwbrrwbr",
        "rrrrrrrr",
        "rrrrrrrr",
        "rrrrrrrr",
        "rr.rr.rr",
      ],
      { r: HUE.orange, w: "#fff", b: "#0969da" },
    ],
    trophy: [
      [
        "..yyyyyyyy..",
        "yyyyyyyyyyyy",
        "y.ywyyyyyy.y",
        "y.ywyyyyyy.y",
        ".yywyyyyyyy.",
        "..yyyyyyyy..",
        "...yyyyyy...",
        ".....yy.....",
        ".....yy.....",
        "....dddd....",
        "...dddddd...",
      ],
      { y: HUE.gold, w: HUE.cream, d: HUE.amber },
    ],
    giftClosed: [GIFT_ROWS, GIFT_PAL],
    // Opening lifts the bow and lid three rows and shows the gold inside.
    giftOpen: [
      [
        ...GIFT_ROWS.slice(3, 7),
        "............",
        "............",
        ".yyyyyyyyyy.",
        ...GIFT_ROWS.slice(7),
      ],
      GIFT_PAL,
    ],
    pot: [
      [
        "..yyyyyyyy..",
        ".yywyyyywyy.",
        "kkkkkkkkkkkk",
        ".kKKKKKKKKk.",
        "kKKKKKKKKKKk",
        "kKKKKKKKKKKk",
        "kKKKKKKKKKKk",
        ".kKKKKKKKKk.",
        "..kkkkkkkk..",
      ],
      { y: HUE.gold, w: HUE.cream, k: HUE.ink, K: HUE.slate },
    ],
    iceCream: [
      [
        "..ppp..",
        ".ppwpp.",
        "ppppppp",
        "ccccccc",
        ".cCcCc.",
        ".ccccc.",
        "..cCc..",
        "..ccc..",
        "...c...",
      ],
      { p: HUE.rose, w: "#fff", c: HUE.crust, C: HUE.bake },
    ],
    mug: [
      [
        "nnnnnnnnnn...",
        "mmmmmmmmmmmm.",
        "mmmmmmmmmm..m",
        "mmmmmmmmmm..m",
        "mmmmmmmmmm..m",
        "mmmmmmmmmmmm.",
        "mmmmmmmmmm...",
        ".mmmmmmmm....",
      ],
      { m: HUE.blue, n: "#6f4e37" },
    ],
    cauldron: [
      [
        ".gggggggggg.",
        "kkkkkkkkkkkk",
        ".kkkkkkkkkk.",
        "kkkkkkkkkkkk",
        "kkkkkkkkkkkk",
        "kkkkkkkkkkkk",
        ".kkkkkkkkkk.",
        "..k......k..",
      ],
      { g: HUE.lime, k: HUE.slate },
    ],
    lemonade: [
      [
        "..ppp.....s",
        ".ppppp...s.",
        "ppppppp.s..",
        "...k...s...",
        "gggkgggsggg",
        "gYYkYYYsYYg",
        "gYYYYYYYYYg",
        "gYwwYYYYYYg",
        "gYwwYYYwwYg",
        "gYYYYYYwwYg",
        "gYYYYYYYYYg",
        "gYYYYYYYYYg",
        ".ggggggggg.",
      ],
      {
        p: HUE.pink,
        s: HUE.red,
        k: "#8a5a2b",
        g: "#afb8c1",
        Y: "#f7e463",
        w: "#fff",
      },
    ],
    flute: [
      [
        "g.....g",
        "gYYYYYg",
        "gYwYYYg",
        "gYYYwYg",
        "gYYYYYg",
        ".gYYYg.",
        "..gYg..",
        "...g...",
        "...g...",
        "...g...",
        ".ggggg.",
      ],
      { g: "#afb8c1", Y: "#f5d76e", w: HUE.cream },
    ],
    cat: [
      [
        ".............",
        ".............",
        ".............",
        "..o......o...",
        "..oo....oo...",
        "..ooossooo...",
        "..oeooooeo...",
        "..oeooooeo...",
        "..ooooppoo...",
        "...oooooo....",
        "...oooooo...o",
        "...oossoo...o",
        "...oooooo.oo.",
        "...oo..oo....",
        "...oo..oo....",
      ],
      {
        o: "#e8833a",
        s: "#a8521a",
        e: HUE.ink,
        p: "#f2a1b5",
        h: HUE.violet,
        b: HUE.orange,
        W: HUE.white,
        R: HUE.red,
        K: "#2d333b",
        Y: HUE.gold,
        G: HUE.green,
        g: "#116329",
        P: "#ff7eb6",
        M: "#d63384",
        C: HUE.blue,
      },
    ],
  };

  function sprite(name, scale, { rows, pal, cls = "" } = {}) {
    const [defaultRows, defaultPal] = SPRITES[name];
    const grid = rows ?? defaultRows;
    const colors = { ...defaultPal, ...pal };
    const width = Math.max(...grid.map((row) => row.length));
    const svg = svgNode("svg", {
      viewBox: `0 0 ${width} ${grid.length}`,
      width: width * scale,
      height: grid.length * scale,
      class: `prb-cel-px ${cls}`,
      "aria-hidden": "true",
    });
    grid.forEach((row, y) => {
      // Neighboring pixels of one color share a rect, which keeps the node count down.
      for (let x = 0; x < row.length; ) {
        let end = x + 1;
        while (row[end] === row[x]) end++;
        const color = colors[row[x]];
        if (color) {
          const rect = svgNode("rect", {
            x,
            y,
            width: end - x + 0.02,
            height: 1.02,
          });
          rect.style.fill = color;
          svg.append(rect);
        }
        x = end;
      }
    });
    return svg;
  }

  // Applies [row, column, character] changes to a sprite's rows, for outfits and decorations.
  function withPixels(rows, pixels) {
    const grid = rows.map((row) => [...row]);
    pixels.forEach(([r, c, ch]) => {
      grid[r][c] = ch;
    });
    return grid.map((row) => row.join(""));
  }
  const pixelRun = (r, from, to, ch) =>
    Array.from({ length: to - from + 1 }, (_, i) => [r, from + i, ch]);
  const pickOne = (list) => list[Math.floor(Math.random() * list.length)];

  // ---------- Decorations shared by every effect ----------
  // Positions are percentages of the decorated sprite, so one set fits sprites of any size.
  const AROUND = [
    [-30, 12, 0],
    [108, 0, 0.7],
    [-14, 68, 1.3],
    [110, 52, 1],
    [45, -22, 0.4],
  ];

  function placeAround(host, className, text, color, count = AROUND.length) {
    AROUND.slice(0, count).forEach(([x, y, delay], i) => {
      const node = element("span", {
        className,
        textContent: text[i % text.length],
      });
      Object.assign(node.style, {
        left: `${x}%`,
        top: `${y}%`,
        animationDelay: `${delay}s`,
        color,
      });
      host.append(node);
    });
  }

  function steam(host, top) {
    [15, 37, 58].forEach((x, i) => {
      const svg = svgNode(
        "svg",
        {
          width: 10,
          height: 28,
          viewBox: "0 0 10 28",
          class: "prb-cel-steam",
          "aria-hidden": "true",
        },
        svgNode("path", {
          d: "M5 27C0 21 10 15 5 9 1 4 7 2 5 0",
          fill: "none",
          stroke: "currentColor",
          "stroke-width": 2,
          "stroke-linecap": "round",
        }),
      );
      Object.assign(svg.style, {
        left: `${x}%`,
        top: `${top}px`,
        animationDelay: `${i * 0.6}s`,
      });
      host.append(svg);
    });
  }

  function bubbles(host, [color, top]) {
    [
      [17, 0],
      [40, 0.5],
      [62, 1],
      [30, 1.3],
      [78, 0.8],
    ].forEach(([x, delay]) => {
      const size = `${4 + Math.random() * 6}px`;
      const node = element("i", { className: "prb-cel-bubble" });
      Object.assign(node.style, {
        left: `${x}%`,
        top: `${top}px`,
        width: size,
        height: size,
        background: color,
        animationDelay: `${delay}s`,
      });
      host.append(node);
    });
  }

  function fireworks(bg, colors) {
    [
      [22, 25, 0],
      [72, 18, 0.6],
      [50, 40, 1.2],
      [88, 50, 0.3],
      [10, 55, 0.9],
    ].forEach(([x, y, delay], i) => {
      const burst = element("div", { className: "prb-cel-fw" });
      Object.assign(burst.style, {
        left: `${x}%`,
        top: `${y}%`,
        color: colors[i % colors.length],
      });
      for (let k = 0; k < 12; k++) {
        const spark = element("i");
        spark.style.setProperty("--prb-a", `${k * 30}deg`);
        spark.style.animationDelay = `${delay}s`;
        burst.append(spark);
      }
      bg.append(burst);
    });
  }

  // Falling or streaking things across the whole box.
  const SKIES = {
    streaks: [
      22,
      () => {
        const node = element("i", { className: "prb-cel-streak" });
        Object.assign(node.style, {
          height: `${4 + Math.random() * 14}px`,
          opacity: 0.35 + Math.random() * 0.6,
          animationDuration: `${0.5 + Math.random() * 0.9}s`,
        });
        return node;
      },
    ],
    hearts: [
      18,
      () => {
        const node = element("i", {
          className: "prb-cel-streak prb-cel-glyph",
          textContent: "♥",
        });
        Object.assign(node.style, {
          color: pickOne([HUE.pink, HUE.red, HUE.rose]),
          animationDuration: `${0.6 + Math.random() * 0.9}s`,
        });
        return node;
      },
    ],
    snow: [
      34,
      () => {
        const size = `${3 + Math.random() * 4}px`;
        const node = element("i", { className: "prb-cel-flake" });
        Object.assign(node.style, {
          width: size,
          height: size,
          animationDuration: `${2.5 + Math.random() * 2.5}s`,
        });
        return node;
      },
    ],
    leaves: [
      14,
      () => {
        const node = element("span", {
          className: "prb-cel-drift",
          textContent: pickOne(["🍂", "🍁"]),
        });
        node.style.animationDuration = `${2.5 + Math.random() * 2}s`;
        return node;
      },
    ],
  };

  function sky(bg, name) {
    const [count, make] = SKIES[name];
    for (let i = 0; i < count; i++) {
      const node = make();
      node.style.left = `${Math.random() * 100}%`;
      node.style.animationDelay = `${-Math.random() * 4}s`;
      bg.append(node);
    }
  }

  // Ghosts fade in and out, each one somewhere new every cycle.
  function ghosts(bg) {
    const place = (node) =>
      Object.assign(node.style, {
        left: `${5 + Math.random() * 85}%`,
        top: `${5 + Math.random() * 60}%`,
      });
    for (let i = 0; i < 4; i++) {
      const ghost = element("span", {
        className: "prb-cel-spook",
        textContent: "👻",
      });
      ghost.style.animationDelay = `${i * 0.7}s`;
      place(ghost);
      ghost.addEventListener("animationiteration", () => place(ghost));
      bg.append(ghost);
    }
  }

  // Options any effect's season entry can use: fireworks, steam, bubbles, rise, fall, and sparkle.
  function decorate(host, bg, c) {
    if (c.fireworks) fireworks(bg, c.fireworks);
    if (c.steam != null) steam(host, c.steam);
    if (c.bubbles) bubbles(host, c.bubbles);
    if (c.rise) placeAround(host, "prb-cel-pt", c.rise[0], c.rise[1], 4);
    if (c.fall)
      placeAround(host, "prb-cel-pt prb-cel-down", c.fall[0], c.fall[1], 4);
    if (c.sparkle) placeAround(host, "prb-cel-tw", "✦", c.sparkle);
  }

  // ---------- Effects ----------
  // Each effect reads its season's entry. Every effect covers every season, plus base.

  const CAT_ARMS = [
    [
      [6, 0, "o"],
      [7, 1, "o"],
      [8, 1, "o"],
      [9, 2, "o"],
      [10, 9, "o"],
      [11, 9, "o"],
    ],
    [
      [10, 2, "o"],
      [11, 2, "o"],
      [9, 9, "o"],
      [8, 10, "o"],
      [7, 10, "o"],
      [6, 11, "o"],
    ],
  ];
  const BRIMMED_HAT = (color) => [
    ...pixelRun(0, 4, 7, color),
    ...pixelRun(1, 4, 7, color),
    [2, 4, "K"],
    [2, 5, "Y"],
    [2, 6, "Y"],
    [2, 7, "K"],
    ...pixelRun(3, 2, 9, color),
  ];
  const CAT = {
    base: { rise: [["♪", "♫"], "var(--fgColor-accent, #0969da)"] },
    halloween: {
      gear: [
        [0, 6, "h"],
        [1, 5, "h"],
        [1, 6, "h"],
        [2, 5, "b"],
        [2, 6, "b"],
        [2, 7, "b"],
        ...pixelRun(3, 1, 10, "h"),
      ],
      rise: [["🦇"]],
    },
    thanksgiving: { gear: BRIMMED_HAT("K"), fall: [["🍂", "🍁"]] },
    winter: {
      gear: [
        [0, 8, "W"],
        [1, 6, "R"],
        [1, 7, "R"],
        ...pixelRun(2, 4, 7, "R"),
        ...pixelRun(3, 2, 9, "W"),
        ...pixelRun(9, 3, 8, "R"),
        [10, 4, "R"],
        [11, 4, "R"],
      ],
      fall: [["❄\uFE0E"], "var(--prb-cel-snow)"],
    },
    newyear: {
      gear: [
        [0, 6, "Y"],
        [1, 5, "M"],
        [1, 6, "C"],
        [2, 4, "C"],
        [2, 5, "M"],
        [2, 6, "C"],
        [2, 7, "M"],
      ],
      rise: [["🎉", "✨"]],
    },
    valentine: {
      gear: [
        [8, 2, "P"],
        [8, 9, "P"],
      ],
      rise: [["♥"], HUE.pink],
    },
    stpatrick: {
      gear: [
        ...BRIMMED_HAT("G"),
        [9, 4, "G"],
        [9, 5, "g"],
        [9, 6, "g"],
        [9, 7, "G"],
      ],
      rise: [["☘\uFE0E"], HUE.green],
    },
    summer: {
      gear: [
        ...pixelRun(6, 2, 9, "K"),
        [7, 3, "K"],
        [7, 4, "K"],
        [7, 7, "K"],
        [7, 8, "K"],
      ],
      rise: [["☀️", "🌴"]],
    },
  };

  function catEffect(c, { anim, bg }) {
    const wrap = element("div", { className: "prb-cel-wrap" });
    const body = element("div", { className: "prb-cel-cat" });
    CAT_ARMS.forEach((arms, i) => {
      const rows = withPixels(SPRITES.cat[0], [...arms, ...(c.gear ?? [])]);
      body.append(sprite("cat", 8, { rows, cls: `prb-cel-f${i + 1}` }));
    });
    wrap.append(body);
    decorate(wrap, bg, c);
    anim.append(wrap);
  }

  const ROCKET = {
    base: { sky: "streaks" },
    halloween: { sky: "streaks", moon: true, ghosts: true },
    thanksgiving: { sky: "leaves" },
    winter: { sky: "snow", stripe: true },
    newyear: {
      sky: "streaks",
      fireworks: [HUE.gold, HUE.purple, HUE.lime, HUE.teal, HUE.orange],
    },
    valentine: { sky: "hearts" },
    stpatrick: { sky: "streaks", trail: true, fins: HUE.green },
    summer: {
      sky: "streaks",
      fireworks: [HUE.coral, HUE.gold, HUE.teal, HUE.orange],
    },
  };

  function rocketEffect(c, { anim, bg }) {
    const outline = { stroke: "#6e7681", "stroke-width": 1.2 };
    const rocket = element(
      "div",
      { className: "prb-cel-rocket" },
      svgNode(
        "svg",
        { viewBox: "0 0 40 80", width: 52, height: 104, "aria-hidden": "true" },
        svgNode(
          "g",
          { class: "prb-cel-flame" },
          svgNode("path", { d: "M13 50Q20 80 27 50Z", fill: HUE.orange }),
          svgNode("path", { d: "M16 50Q20 68 24 50Z", fill: HUE.gold }),
        ),
        svgNode("path", {
          d: "M10 36 2 56 10 50ZM30 36 38 56 30 50Z",
          fill: c.fins ?? "#da3633",
        }),
        svgNode("path", {
          d: "M20 3C28 13 30 28 30 47H10C10 28 12 13 20 3Z",
          fill: "#e6edf3",
          ...outline,
        }),
        ...(c.stripe
          ? [svgNode("path", { d: "M10.6 33h18.8v4H10.4Z", fill: HUE.red })]
          : []),
        svgNode("circle", { cx: 20, cy: 25, r: 5, fill: HUE.blue, ...outline }),
        svgNode("rect", {
          x: 13,
          y: 47,
          width: 14,
          height: 4,
          rx: 1,
          fill: "#6e7681",
        }),
      ),
    );
    if (c.trail) rocket.prepend(element("div", { className: "prb-cel-trail" }));
    anim.append(rocket);
    if (c.moon) bg.append(element("div", { className: "prb-cel-moon" }));
    if (c.ghosts) ghosts(bg);
    sky(bg, c.sky);
    decorate(rocket, bg, c);
  }

  const ORNAMENT_PALS = [HUE.red, HUE.green, HUE.blue].map((r) => ({ r }));
  const STAR_PALS = [HUE.gold, HUE.purple, HUE.teal, HUE.orange].map((y) => ({
    y,
  }));
  const HEART_PALS = [HUE.pink, HUE.red, HUE.rose].map((p) => ({ p }));

  // item: [sprite, scale, palettes]. Without one, Pac-Man eats pull request icons.
  const PAC = {
    base: { done: "CLEAR!" },
    halloween: { done: "BOO!", ghost: true },
    thanksgiving: { done: "STUFFED!", item: ["pie", 2] },
    winter: { done: "HO HO HO!", item: ["ornament", 2.4, ORNAMENT_PALS] },
    newyear: { done: "CHEERS!", item: ["star", 2.4, STAR_PALS] },
    valentine: { done: "XOXO", item: ["heart", 2.6, HEART_PALS] },
    stpatrick: { done: "LUCKY!", item: ["coin", 3] },
    summer: { done: "CHILL!", item: ["melon", 2.4] },
  };

  function pacEffect(c, { anim }) {
    const field = element("div", { className: "prb-cel-pacfield" });
    if (c.ghost)
      field.append(
        element("div", { className: "prb-cel-ghost" }, sprite("ghost", 3)),
      );
    const belt = element("div", { className: "prb-cel-belt" });
    for (let i = 0; i < 5; i++) {
      if (!c.item) {
        const icon = octicon(PULL_REQUEST_ICON_PATH);
        icon.classList.add("prb-cel-pr");
        belt.append(icon);
        continue;
      }
      const [name, scale, pals] = c.item;
      belt.append(sprite(name, scale, { pal: pals?.[i % pals.length] }));
    }
    field.append(
      element("div", { className: "prb-cel-pac" }),
      element("div", { className: "prb-cel-lane" }, belt),
      element("div", { className: "prb-cel-clear", textContent: c.done }),
    );
    anim.append(field);
  }

  // Lines starting with "$ " are typed out; the rest print whole. {year} becomes the celebrated year.
  const LIST_COMMAND = '$ gh pr list --search "review-requested:@me"';
  const NO_RESULTS = "no pull requests match your search";
  const TERMINAL = {
    base: [
      LIST_COMMAND,
      NO_RESULTS,
      "$ git status",
      "nothing to review, working tree clean ✨",
    ],
    halloween: [
      LIST_COMMAND,
      NO_RESULTS,
      "$ git status",
      "nothing to review. it's quiet. too quiet 🎃",
    ],
    thanksgiving: [
      LIST_COMMAND,
      NO_RESULTS,
      "$ echo $GRATITUDE",
      "thankful for an empty review queue 🙏",
    ],
    winter: [
      "$ santa --check-twice --list=prs",
      "naughty: 0    nice: all of them",
      "$ git status",
      "everything's wrapped up 🎁",
    ],
    newyear: [
      "$ git tag v{year} && git push --tags",
      " * [new tag]  v{year} -> v{year}",
      LIST_COMMAND,
      "new year, zero PRs 🥂",
    ],
    valentine: [
      LIST_COMMAND,
      NO_RESULTS,
      '$ git commit -m "<3"',
      "[main 0214] you reviewed everything ❤️",
    ],
    stpatrick: [
      LIST_COMMAND,
      NO_RESULTS,
      "$ git pull --luck",
      "found a pot of gold: 0 PRs 🍀",
    ],
    summer: [
      LIST_COMMAND,
      NO_RESULTS,
      "$ git switch -c vacation",
      "Switched to a new branch 'vacation' 🏖️",
    ],
  };

  function terminalEffect(lines, { anim, later }) {
    const year = String(celebratedYear(new Date()));
    const screen = element("div", { className: "prb-cel-term" });
    anim.append(screen);
    let index = 0;
    let typed = 0;
    let current;
    const tick = () => {
      if (index === lines.length) {
        later(() => {
          screen.textContent = "";
          index = 0;
          tick();
        }, 2800);
        return;
      }
      const line = lines[index].replaceAll("{year}", year);
      const isCommand = line.startsWith("$ ");
      if (typed === 0) {
        current = element("div", { className: isCommand ? "" : "prb-cel-out" });
        screen.append(current);
      }
      if (!isCommand) {
        current.textContent = line;
        index++;
        later(tick, 450);
        return;
      }
      typed = typed === 0 ? 3 : typed + 1;
      current.textContent = line.slice(0, typed);
      if (typed < line.length) return later(tick, 38);
      index++;
      typed = 0;
      later(tick, 500);
    };
    tick();
  }

  // [sprite, scale, palettes]
  const INVADERS = {
    base: ["invader", 3],
    halloween: ["pumpkin", 3],
    thanksgiving: ["pie", 2.6],
    winter: ["ornament", 3, ORNAMENT_PALS],
    newyear: ["star", 3.2, STAR_PALS],
    valentine: ["heart", 3, HEART_PALS],
    stpatrick: ["clover", 3, [{ g: HUE.green }, { g: HUE.lime }]],
    summer: ["melon", 3.4],
  };

  function invadersEffect([name, scale, pals], { anim, later }) {
    const field = element("div", { className: "prb-cel-field" });
    anim.append(field);
    const run = () => {
      field.textContent = "";
      const row = element("div", { className: "prb-cel-invrow" });
      const invaders = [0, 1, 2, 3, 4].map((i) => {
        const invader = element(
          "div",
          { className: "prb-cel-inv" },
          sprite(name, scale, { pal: pals?.[i % pals.length] }),
        );
        invader.style.left = `${16 + i * 56}px`;
        row.append(invader);
        return invader;
      });
      const ship = element(
        "div",
        { className: "prb-cel-ship" },
        sprite("ship", 3),
      );
      field.append(row, ship);
      let hit = 0;
      const fire = () => {
        if (hit === invaders.length) {
          field.append(
            element("div", {
              className: "prb-cel-wavemsg",
              textContent: "WAVE CLEAR · 0 LEFT",
            }),
          );
          later(run, 2200);
          return;
        }
        const x = 16 + hit * 56 + 16.5;
        ship.style.left = `${x - 13.5}px`;
        later(() => {
          const bullet = element("div", { className: "prb-cel-bullet" });
          bullet.style.left = `${x - 1.5}px`;
          field.append(bullet);
          bullet.getBoundingClientRect();
          bullet.style.top = "20px";
          later(() => {
            bullet.remove();
            invaders[hit++].classList.add("prb-cel-dead");
            later(fire, 220);
          }, 260);
        }, 330);
      };
      later(fire, 700);
    };
    run();
  }

  // frames: two sprites that swap partway through a 3s loop, with a glow when the second appears.
  const REWARD = {
    base: { sprite: ["trophy", 7, "prb-cel-bounce"], sparkle: HUE.gold },
    halloween: {
      sprite: ["pumpkin", 10, "prb-cel-lantern"],
      sparkle: HUE.orange,
    },
    thanksgiving: {
      sprite: ["pie", 8, "prb-cel-bounce"],
      steam: -34,
      sparkle: HUE.gold,
    },
    winter: { frames: ["giftClosed", "giftOpen", 7], sparkle: HUE.gold },
    newyear: {
      sprite: ["star", 11, "prb-cel-bounce"],
      fireworks: [HUE.gold, HUE.purple, HUE.lime, HUE.teal],
      sparkle: HUE.gold,
    },
    valentine: { sprite: ["heart", 12, "prb-cel-beat"], sparkle: HUE.pink },
    stpatrick: {
      sprite: ["pot", 8, "prb-cel-bounce"],
      rainbow: true,
      sparkle: HUE.gold,
    },
    summer: { sprite: ["iceCream", 9, "prb-cel-bounce"], sparkle: HUE.rose },
  };

  function rewardEffect(c, { anim, bg }) {
    const wrap = element("div", { className: "prb-cel-wrap" });
    if (c.rainbow)
      wrap.append(element("div", { className: "prb-cel-rainbow" }));
    if (c.frames) {
      const [closed, open, scale] = c.frames;
      wrap.append(
        element("div", { className: "prb-cel-glow" }),
        element(
          "div",
          { className: "prb-cel-reveal" },
          sprite(closed, scale),
          sprite(open, scale),
        ),
      );
    } else {
      const [name, scale, cls] = c.sprite;
      wrap.append(sprite(name, scale, { cls }));
    }
    decorate(wrap, bg, c);
    anim.append(wrap);
  }

  // top: extra rows above the mug. pixels: changes to the mug's own rows. pair: two glasses that clink.
  const DRINK = {
    base: { sprite: ["mug"], steam: -36 },
    halloween: { sprite: ["cauldron"], bubbles: [HUE.lime, -6] },
    thanksgiving: {
      sprite: ["mug", { m: HUE.orange, n: "#f3e1c7", w: "#fffaf0" }],
      top: ["..wwwwwww...."],
      steam: -36,
    },
    winter: {
      sprite: ["mug", { m: HUE.red, n: "#5a3a22", w: "#fde2e4", x: "#e8b4bc" }],
      top: ["..ww....ww...", ".www.ww.www..", ".xxx.xx.xxx.."],
      steam: -50,
    },
    newyear: {
      sprite: ["flute"],
      pair: true,
      bubbles: [HUE.gold, -6],
      sparkle: HUE.gold,
    },
    valentine: {
      sprite: ["mug", { m: HUE.pink, h: "#fff" }],
      pixels: [
        [2, 3, "h"],
        [2, 5, "h"],
        ...pixelRun(3, 3, 5, "h"),
        [4, 4, "h"],
      ],
      rise: [["♥"], HUE.pink],
    },
    stpatrick: {
      sprite: ["mug", { m: "#2da44e", n: "#b4f1be", w: "#fffaf0" }],
      top: ["..wwwwwww....", ".wwwwwwwww..."],
      rise: [["☘\uFE0E"], HUE.green],
    },
    summer: {
      sprite: ["lemonade", {}, "prb-cel-bounce"],
      bubbles: ["#fffbe6", 70],
    },
  };

  function drinkEffect(c, { anim, bg }) {
    const wrap = element("div", { className: "prb-cel-wrap" });
    const [name, pal, cls] = c.sprite;
    let rows = SPRITES[name][0];
    if (c.top) rows = [...c.top, ...rows];
    if (c.pixels) rows = withPixels(rows, c.pixels);
    const glass = () => sprite(name, 8, { rows, pal, cls });
    wrap.append(
      c.pair
        ? element("div", { className: "prb-cel-clink" }, glass(), glass())
        : glass(),
    );
    decorate(wrap, bg, c);
    anim.append(wrap);
  }

  // The first color is the falling piece.
  const TETRIS = {
    base: [
      "#00b4d8",
      HUE.gold,
      HUE.purple,
      HUE.lime,
      "#f85149",
      HUE.blue,
      HUE.orange,
    ],
    halloween: [HUE.orange, "#8250df", "#d29922", HUE.lime, HUE.rust],
    thanksgiving: [HUE.rust, "#d29922", HUE.amber, HUE.red, HUE.orange],
    winter: [HUE.red, HUE.green, "#e6edf3", HUE.gold],
    newyear: [HUE.gold, HUE.purple, HUE.teal, HUE.orange, HUE.amber],
    valentine: [HUE.pink, HUE.red, HUE.rose, "#bf3989"],
    stpatrick: [HUE.green, HUE.lime, HUE.gold, "#2da44e"],
    summer: [HUE.blue, HUE.gold, HUE.teal, HUE.orange],
  };

  function tetrisEffect(colors, { anim, later }) {
    const board = element("div", { className: "prb-cel-tet" });
    const cells = Array.from({ length: 60 }, () => element("i"));
    board.append(...cells);
    anim.append(board);
    const run = () => {
      const grid = Array.from({ length: 6 }, () => Array(10).fill(-1));
      [
        [5, [0, 1, 2, 7, 8, 9]],
        [4, [0, 1, 2, 8, 9]],
        [3, [0, 9]],
        [2, [0]],
      ].forEach(([r, cols]) =>
        cols.forEach((c) => {
          grid[r][c] = 1 + ((r * 3 + c) % (colors.length - 1));
        }),
      );
      const draw = (pieceRow) =>
        cells.forEach((cell, i) => {
          const r = Math.floor(i / 10);
          const c = i % 10;
          const value = r === pieceRow && c >= 3 && c <= 6 ? 0 : grid[r][c];
          cell.className = value < 0 ? "" : "prb-cel-on";
          cell.style.background = value < 0 ? "" : colors[value];
        });
      let row = 0;
      const drop = () => {
        draw(row);
        if (row < 5) {
          row++;
          later(drop, 140);
          return;
        }
        grid[5].fill(0, 3, 7);
        let flashes = 0;
        const flash = () => {
          cells
            .slice(50)
            .forEach((cell) =>
              cell.classList.toggle("prb-cel-flash", flashes % 2 === 0),
            );
          if (++flashes < 6) return later(flash, 110);
          grid.splice(5, 1);
          grid.unshift(Array(10).fill(-1));
          draw(-1);
          later(run, 1600);
        };
        later(flash, 150);
      };
      drop();
    };
    run();
  }

  const CELEBRATIONS = {
    cat: [catEffect, CAT],
    rocket: [rocketEffect, ROCKET],
    pac: [pacEffect, PAC],
    terminal: [terminalEffect, TERMINAL],
    invaders: [invadersEffect, INVADERS],
    reward: [rewardEffect, REWARD],
    drink: [drinkEffect, DRINK],
    tetris: [tetrisEffect, TETRIS],
  };

  // [heading, line below it] for each effect and season.
  const CELEBRATION_MESSAGES = {
    cat: {
      base: [
        "Review queue: cleared.",
        "Nothing needs you right now. Dance break.",
      ],
      halloween: [
        "No tricks left in the queue.",
        "The cat's celebrating. Treat yourself.",
      ],
      thanksgiving: ["Plate cleared.", "Thankful for an empty review queue."],
      winter: [
        "Sleigh-ing the review queue.",
        "Every PR reviewed. Enjoy the break.",
      ],
      newyear: ["New year, empty queue.", "Party time. Zero PRs."],
      valentine: ["Your teammates love you.", "Every review done. ♥"],
      stpatrick: ["Lucky you.", "Not a PR in sight. Jig accordingly."],
      summer: ["Too cool for a backlog.", "Queue's clear. Go outside."],
    },
    rocket: {
      base: ["Backlog cleared. Ship it.", "Zero open PRs waiting on you."],
      halloween: ["Flying past the full moon.", "Not a spooky PR in sight."],
      thanksgiving: [
        "Leaving the backlog behind.",
        "Like leaves in the wind. Zero PRs.",
      ],
      winter: ["Sleigh, upgraded.", "Every PR delivered. Ho ho ho."],
      newyear: ["Launching into the new year.", "With an empty queue."],
      valentine: ["Sending love to the team.", "Every review done. ♥"],
      stpatrick: ["Riding the rainbow.", "Zero PRs at the end of it."],
      summer: ["Liftoff, it's summer.", "Queue's clear. Fireworks are on us."],
    },
    pac: {
      base: ["You ate the whole backlog.", "No pull requests left. Om nom."],
      halloween: [
        "Ate the backlog, outran the ghost.",
        "Not a PR left to haunt you.",
      ],
      thanksgiving: ["Seconds? No PRs left.", "You cleared your plate."],
      winter: [
        "Ornaments: eaten. Queue: empty.",
        "Please don't eat real ornaments.",
      ],
      newyear: ["Nom nom, new year.", "Every PR eaten before midnight."],
      valentine: ["You gobbled up the love.", "Every review done. ♥"],
      stpatrick: ["You ate all the gold.", "Zero PRs. Lucky and full."],
      summer: ["Summer snack, empty queue.", "Every PR eaten. Watermelon too."],
    },
    terminal: {
      base: ["Working tree clean.", "Nothing left to review."],
      halloween: ["Nothing lurking in the queue.", "It's quiet. Too quiet."],
      thanksgiving: [
        "Gratitude committed.",
        "Thankful for an empty review queue.",
      ],
      winter: ["Naughty list: empty.", "Every PR checked twice."],
      newyear: ["Tagged and released.", "Starting the year with zero PRs."],
      valentine: ["Committed to you.", "Every review done. ♥"],
      stpatrick: ["git pull --luck succeeded.", "Zero PRs found."],
      summer: ["Checked out to vacation.", "Nothing left to review."],
    },
    invaders: {
      base: ["Wave cleared.", "Every PR defeated. New high score."],
      halloween: ["Pumpkins smashed.", "Every PR defeated. Happy Halloween."],
      thanksgiving: [
        "Pie defense complete.",
        "Every PR defeated. Save room for dessert.",
      ],
      winter: ["Ornaments down.", "Every PR defeated. Deck the halls."],
      newyear: ["Stars shot down.", "Every PR defeated before midnight."],
      valentine: ["Hearts collected.", "Every PR defeated, lovingly."],
      stpatrick: ["Shamrocks cleared.", "Every PR defeated. Lucky shot."],
      summer: ["Watermelon wave cleared.", "Every PR defeated. Grab a slice."],
    },
    reward: {
      base: ["Achievement unlocked: Inbox Zero.", "Every review done."],
      halloween: ["Jack-o'-lantern lit.", "No PRs left to carve."],
      thanksgiving: ["Dessert earned.", "Every review done. Have a slice."],
      winter: ["You unwrapped a present.", "Inside: zero pull requests."],
      newyear: [
        "Achievement unlocked: fresh start.",
        "Zero PRs to kick off the year.",
      ],
      valentine: ["Your queue loves you back.", "Every review done. ♥"],
      stpatrick: ["Found the pot of gold.", "Every review done."],
      summer: ["Treat yourself.", "Queue's clear. Ice cream earned."],
    },
    drink: {
      base: ["Queue's empty. Go get a coffee.", "You've earned it."],
      halloween: ["Something's brewing.", "Not PRs, though. Those are done."],
      thanksgiving: [
        "Pumpkin spice and zero PRs.",
        "Sip slowly. Nothing needs you.",
      ],
      winter: ["Hot cocoa time.", "Every PR reviewed. Marshmallows earned."],
      newyear: ["Cheers to an empty queue.", "Here's to the new year."],
      valentine: ["A warm cup, an empty queue.", "Every review done. ♥"],
      stpatrick: ["Shamrock shake o'clock.", "Every PR reviewed. Lucky you."],
      summer: ["Lemonade break.", "Queue's clear. Stay cool."],
    },
    tetris: {
      base: ["Line clear!", "Your review queue just collapsed to zero."],
      halloween: ["Spooky line clear!", "The queue vanished like a ghost."],
      thanksgiving: [
        "Harvest cleared.",
        "Every PR reviewed. Fall back and relax.",
      ],
      winter: ["Line clear, holiday edition.", "Every PR stacked away."],
      newyear: ["Clearing lines for the new year.", "Fresh board, zero PRs."],
      valentine: [
        "Perfect fit.",
        "You and an empty queue: made for each other.",
      ],
      stpatrick: ["Lucky line clear!", "Zero PRs left on the board."],
      summer: ["Summer line clear!", "Queue's clear. Off to the beach."],
    },
  };

  // Adds a celebration just before anchor and returns a function that stops and removes it. Leaving out effect
  // or season picks a random effect and today's season. Timers stop on their own once the element
  // is no longer in the page, so a GitHub redraw that drops it leaves nothing running.
  function celebrate(
    anchor,
    {
      effect = pickOne(Object.keys(CELEBRATIONS)),
      season = celebrationSeason(new Date()),
    } = {},
  ) {
    injectStyles("prb-cel-styles", CELEBRATION_CSS);
    const timers = new Set();
    const root = element("div", { className: "prb-cel" });
    const stop = () => {
      timers.forEach(clearTimeout);
      timers.clear();
      root.remove();
    };
    const later = (fn, ms) => {
      const id = setTimeout(() => {
        timers.delete(id);
        if (!root.isConnected) stop();
        // A hidden tab checks back once a second instead, so the loops don't churn the page unseen.
        else if (document.hidden) later(fn, 1000);
        else fn();
      }, ms);
      timers.add(id);
    };
    // The animation is decoration, so screen readers get only the message.
    const bg = element("div", { className: "prb-cel-bg", ariaHidden: "true" });
    const anim = element("div", {
      className: "prb-cel-anim",
      ariaHidden: "true",
    });
    const [heading, line] = CELEBRATION_MESSAGES[effect][season];
    root.dataset.effect = effect;
    root.dataset.season = season;
    root.append(
      bg,
      anim,
      element(
        "div",
        { className: "prb-cel-msg" },
        element("h3", { textContent: heading }),
        element("p", { textContent: line }),
      ),
    );
    anchor.before(root);
    const [render, seasons] = CELEBRATIONS[effect];
    render(seasons[season], { anim, bg, later });
    return stop;
  }

  const CELEBRATION_CSS = `
    :root { --prb-cel-snow: #9ec5fe; }
    [data-color-mode="dark"] { --prb-cel-snow: #e6edf3; }
    @media (prefers-color-scheme: dark) {
      [data-color-mode="auto"] { --prb-cel-snow: #e6edf3; }
    }
    .prb-cel { position: relative; height: 240px; overflow: hidden; }
    .prb-cel + [data-component="Blankslate"] { display: none; }
    .prb-cel-bg { position: absolute; inset: 0; pointer-events: none; mask-image: linear-gradient(#000 50%, transparent 72%); }
    .prb-cel-anim { position: absolute; inset: 0 0 76px; display: flex; align-items: center; justify-content: center; }
    .prb-cel-msg { position: absolute; left: 0; right: 0; bottom: 18px; z-index: 2; padding: 0 12px; text-align: center; }
    .prb-cel-msg h3 { margin: 0; font-family: inherit; font-size: 20px; font-weight: 600; line-height: 1.25; color: var(--fgColor-default, #1f2328); }
    .prb-cel-msg p { margin: 2px 0 0; font-size: 14px; line-height: 1.5; color: var(--fgColor-muted, #59636e); }
    .prb-cel-px { display: block; shape-rendering: crispEdges; }
    .prb-cel-wrap { position: relative; }

    .prb-cel-pt { position: absolute; font-size: 20px; opacity: 0; animation: prb-cel-rise 2.2s ease-out infinite; }
    .prb-cel-down { animation-name: prb-cel-sink; }
    @keyframes prb-cel-rise { 0% { opacity: 0; transform: translateY(10px); } 20% { opacity: 1; } 100% { opacity: 0; transform: translateY(-50px) rotate(20deg); } }
    @keyframes prb-cel-sink { 0% { opacity: 0; transform: translateY(-30px); } 20% { opacity: 1; } 100% { opacity: 0; transform: translateY(40px) rotate(40deg); } }
    .prb-cel-tw { position: absolute; font-size: 16px; animation: prb-cel-twinkle 1.6s ease-in-out infinite; }
    @keyframes prb-cel-twinkle { 0%, 100% { opacity: 0; transform: scale(.4); } 50% { opacity: 1; transform: scale(1); } }
    .prb-cel-streak { position: absolute; top: -20px; width: 2px; border-radius: 1px; background: var(--fgColor-muted, #59636e); animation: prb-cel-fall linear infinite; }
    .prb-cel-glyph { width: auto; background: none; font-size: 12px; font-style: normal; }
    .prb-cel-flake { position: absolute; top: -10px; border-radius: 50%; background: var(--prb-cel-snow); animation: prb-cel-snow linear infinite; }
    .prb-cel-drift { position: absolute; top: -24px; font-size: 16px; animation: prb-cel-leaf linear infinite; }
    @keyframes prb-cel-fall { to { transform: translateY(280px); } }
    @keyframes prb-cel-snow { to { transform: translate(24px, 280px); } }
    @keyframes prb-cel-leaf { to { transform: translate(40px, 280px) rotate(360deg); } }
    .prb-cel-fw { position: absolute; }
    .prb-cel-fw i { position: absolute; width: 4px; height: 4px; margin: -2px; border-radius: 50%; background: currentColor; opacity: 0; animation: prb-cel-boom 1.8s ease-out infinite; }
    @keyframes prb-cel-boom { 0% { opacity: 1; transform: rotate(var(--prb-a)) translateX(0); } 100% { opacity: 0; transform: rotate(var(--prb-a)) translateX(36px); } }
    .prb-cel-steam { position: absolute; color: var(--fgColor-muted, #59636e); opacity: 0; animation: prb-cel-steam 2s ease-out infinite; }
    @keyframes prb-cel-steam { 0% { opacity: 0; transform: translateY(8px); } 40% { opacity: .8; } 100% { opacity: 0; transform: translateY(-18px); } }
    .prb-cel-bubble { position: absolute; border-radius: 50%; opacity: 0; animation: prb-cel-bubble 1.6s ease-out infinite; }
    @keyframes prb-cel-bubble { 0% { opacity: 0; transform: translateY(0) scale(.5); } 20% { opacity: 1; } 100% { opacity: 0; transform: translateY(-40px) scale(1.2); } }
    .prb-cel-spook { position: absolute; font-size: 22px; opacity: 0; animation: prb-cel-spook 2.8s ease-in-out infinite; }
    @keyframes prb-cel-spook { 0%, 100% { opacity: 0; transform: scale(.8); } 40%, 60% { opacity: .85; transform: scale(1); } }
    .prb-cel-moon { position: absolute; right: 14%; top: 18px; width: 56px; height: 56px; border-radius: 50%; background: #f6e7a1; box-shadow: 0 0 28px #f6e7a188; }

    .prb-cel-cat { position: relative; animation: prb-cel-bob .5s steps(1) infinite; }
    .prb-cel-cat svg + svg { position: absolute; inset: 0; }
    .prb-cel-f1 { animation: prb-cel-show .5s steps(1) infinite; }
    .prb-cel-f2 { opacity: 0; animation: prb-cel-show .5s steps(1) infinite reverse; }
    @keyframes prb-cel-show { 0% { opacity: 1; } 50% { opacity: 0; } }
    @keyframes prb-cel-bob { 0% { transform: translateY(0) rotate(-4deg); } 50% { transform: translateY(-6px) rotate(4deg); } }

    .prb-cel-rocket { position: relative; z-index: 1; animation: prb-cel-shake .12s linear infinite; }
    .prb-cel-rocket svg { display: block; }
    .prb-cel-flame { transform-origin: 20px 50px; animation: prb-cel-flicker .15s ease-in-out infinite alternate; }
    @keyframes prb-cel-flicker { from { transform: scaleY(.75); } to { transform: scaleY(1.15); } }
    @keyframes prb-cel-shake { 0%, 100% { transform: translate(0, 0); } 25% { transform: translate(-1px, 1px); } 75% { transform: translate(1px, -1px); } }
    .prb-cel-trail { position: absolute; left: 50%; top: 68px; width: 18px; height: 150px; z-index: -1; transform-origin: top; background: linear-gradient(90deg, ${RAINBOW.map((color, i) => `${color} ${(i * 100) / 6}% ${((i + 1) * 100) / 6}%`).join(", ")}); mask-image: linear-gradient(#000, transparent); animation: prb-cel-wave .5s ease-in-out infinite alternate; }
    @keyframes prb-cel-wave { from { transform: translateX(-50%) skewX(-10deg); } to { transform: translateX(-50%) skewX(10deg); } }

    .prb-cel-pacfield { position: relative; width: 360px; height: 48px; }
    .prb-cel-pac { position: absolute; left: 56px; top: 6px; width: 36px; height: 36px; z-index: 2; }
    .prb-cel-pac::before, .prb-cel-pac::after { content: ""; position: absolute; left: 0; width: 36px; height: 18px; background: #f5c518; }
    .prb-cel-pac::before { top: 0; border-radius: 18px 18px 0 0; transform-origin: 50% 100%; animation: prb-cel-jaw-top .25s linear infinite alternate; }
    .prb-cel-pac::after { top: 18px; border-radius: 0 0 18px 18px; transform-origin: 50% 0; animation: prb-cel-jaw-bottom .25s linear infinite alternate; }
    @keyframes prb-cel-jaw-top { to { transform: rotate(-35deg); } }
    @keyframes prb-cel-jaw-bottom { to { transform: rotate(35deg); } }
    .prb-cel-ghost { position: absolute; left: 6px; top: 12px; animation: prb-cel-hover .4s ease-in-out infinite alternate; }
    @keyframes prb-cel-hover { to { transform: translateY(-4px); } }
    .prb-cel-lane { position: absolute; left: 74px; right: 0; top: 0; bottom: 0; overflow: hidden; }
    .prb-cel-belt { position: absolute; top: 0; bottom: 0; left: 0; display: flex; align-items: center; gap: 24px; animation: prb-cel-belt 5s linear infinite; }
    .prb-cel-belt > * { flex: none; }
    .prb-cel-pr { width: 16px; height: 16px; fill: var(--fgColor-success, #1a7f37); }
    @keyframes prb-cel-belt { 0% { transform: translateX(290px); } 70%, 100% { transform: translateX(-240px); } }
    .prb-cel-clear { position: absolute; right: 4px; top: 8px; font: 700 18px/32px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .05em; color: var(--fgColor-success, #1a7f37); opacity: 0; animation: prb-cel-clear 5s linear infinite; }
    @keyframes prb-cel-clear { 0%, 70% { opacity: 0; transform: scale(.6); } 76% { opacity: 1; transform: scale(1.2); } 82%, 95% { opacity: 1; transform: scale(1); } 100% { opacity: 0; } }

    .prb-cel-term { width: min(440px, 92%); height: 118px; padding: 10px 12px; overflow: hidden; text-align: left; white-space: pre; background: #0d1117; color: #e6edf3; border: 1px solid var(--borderColor-default, #d1d9e0); border-radius: 6px; font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .prb-cel-out { color: #3fb950; }
    .prb-cel-term div:last-child::after { content: "▋"; color: #9198a1; animation: prb-cel-show 1s steps(1) infinite; }

    .prb-cel-field { position: relative; width: 300px; height: 136px; }
    .prb-cel-invrow { position: absolute; inset: 0; animation: prb-cel-march 1s steps(1) infinite; }
    @keyframes prb-cel-march { 0% { transform: translateX(-4px); } 50% { transform: translateX(4px); } }
    .prb-cel-inv { position: absolute; top: 6px; width: 33px; height: 26px; display: flex; align-items: center; justify-content: center; }
    .prb-cel-dead { animation: prb-cel-pop .25s forwards; }
    @keyframes prb-cel-pop { to { transform: scale(1.7); opacity: 0; } }
    .prb-cel-ship { position: absolute; top: 116px; left: 136px; transition: left .3s ease-in-out; }
    .prb-cel-bullet { position: absolute; top: 106px; width: 3px; height: 10px; background: var(--fgColor-accent, #0969da); transition: top .25s linear; }
    .prb-cel-wavemsg { position: absolute; top: 40px; left: 0; right: 0; text-align: center; font: 700 18px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fgColor-success, #1a7f37); animation: prb-cel-pop-in .3s; }
    @keyframes prb-cel-pop-in { from { transform: scale(.5); opacity: 0; } }

    .prb-cel-bounce { animation: prb-cel-bounce 1.2s ease-in-out infinite alternate; }
    @keyframes prb-cel-bounce { to { transform: translateY(-8px); } }
    .prb-cel-beat { animation: prb-cel-beat 1.1s ease-in-out infinite; }
    @keyframes prb-cel-beat { 0%, 60%, 100% { transform: scale(1); } 15% { transform: scale(1.15); } 30% { transform: scale(1); } 45% { transform: scale(1.1); } }
    .prb-cel-lantern { animation: prb-cel-lantern .18s ease-in-out infinite alternate; }
    @keyframes prb-cel-lantern { from { filter: drop-shadow(0 0 6px #f0883e); } to { filter: drop-shadow(0 0 14px #f5c518); } }
    .prb-cel-reveal { position: relative; animation: prb-cel-wiggle 3s ease-in-out infinite; }
    .prb-cel-reveal svg:first-child { animation: prb-cel-swap-out 3s steps(1) infinite; }
    .prb-cel-reveal svg + svg { position: absolute; left: 0; bottom: 0; opacity: 0; animation: prb-cel-swap-in 3s steps(1) infinite; }
    @keyframes prb-cel-swap-out { 0% { opacity: 1; } 55% { opacity: 0; } }
    @keyframes prb-cel-swap-in { 0% { opacity: 0; } 55% { opacity: 1; } }
    @keyframes prb-cel-wiggle { 0%, 30%, 55%, 100% { transform: rotate(0); } 35%, 45% { transform: rotate(-4deg); } 40%, 50% { transform: rotate(4deg); } }
    .prb-cel-glow { position: absolute; left: 50%; top: 40%; width: 160px; height: 160px; margin: -80px; border-radius: 50%; background: radial-gradient(#f5c51899, transparent 65%); opacity: 0; animation: prb-cel-glow 3s ease-out infinite; }
    @keyframes prb-cel-glow { 0%, 54% { opacity: 0; transform: scale(.4); } 62% { opacity: 1; transform: scale(1); } 92% { opacity: 1; } 100% { opacity: 0; } }
    .prb-cel-rainbow { position: absolute; left: 50%; bottom: 20px; width: 220px; height: 110px; margin-left: -110px; border-radius: 110px 110px 0 0; background: radial-gradient(circle 110px at 50% 100%, transparent 56%, ${[
      ...RAINBOW,
    ]
      .reverse()
      .map((color, i) => `${color} ${56 + i * 7}% ${63 + i * 7}%`)
      .join(
        ", ",
      )}, transparent 98%); animation: prb-cel-arc 3.5s ease-in-out infinite; }
    @keyframes prb-cel-arc { 0% { clip-path: inset(0 100% 0 0); } 35%, 90% { clip-path: inset(0); } 100% { clip-path: inset(0); opacity: 0; } }

    .prb-cel-clink { display: flex; gap: 2px; align-items: flex-end; }
    .prb-cel-clink svg { transform-origin: 50% 100%; }
    .prb-cel-clink svg:first-child { animation: prb-cel-clink-left 1.6s ease-in-out infinite; }
    .prb-cel-clink svg:last-child { animation: prb-cel-clink-right 1.6s ease-in-out infinite; }
    @keyframes prb-cel-clink-left { 0%, 55%, 100% { transform: rotate(-14deg) translateX(-8px); } 70% { transform: rotate(-3deg) translateX(3px); } }
    @keyframes prb-cel-clink-right { 0%, 55%, 100% { transform: rotate(14deg) translateX(8px); } 70% { transform: rotate(3deg) translateX(-3px); } }

    .prb-cel-tet { display: grid; grid-template-columns: repeat(10, 16px); gap: 1px; padding: 3px; background: var(--bgColor-muted, #f6f8fa); border: 1px solid var(--borderColor-default, #d1d9e0); border-radius: 4px; }
    .prb-cel-tet i { display: block; width: 16px; height: 16px; border-radius: 2px; }
    .prb-cel-on { box-shadow: inset -2px -2px rgba(0, 0, 0, .25), inset 2px 2px rgba(255, 255, 255, .35); }
    .prb-cel-tet .prb-cel-flash { background: #fff !important; box-shadow: 0 0 6px #fff; }
    /* Freezes each effect on its first frame. Particles start hidden, so they drop out entirely. */
    @media (prefers-reduced-motion: reduce) {
      .prb-cel *, .prb-cel *::before, .prb-cel *::after { animation: none !important; transition: none !important; }
      .prb-cel-pac::before { transform: rotate(-30deg); }
      .prb-cel-pac::after { transform: rotate(30deg); }
    }
  `;

  // One celebration at a time. Each query keeps the effect it first rolled until the page reloads,
  // so a GitHub redraw of the empty list brings back the same one.
  const celebration = { stop: null, root: null, key: null };
  const celebrationEffects = new Map();

  // The empty state and the query that produced it, or null. The selected tab's link holds the
  // submitted query, and its "(0)" rules out the empty state GitHub can flash while results load.
  function emptyList() {
    const blankslate = document.querySelector('[data-component="Blankslate"]');
    const tab = document.querySelector('a[aria-current="true"][href*="q="]');
    if (!blankslate || !tab || listRows().length) return null;
    if (!/\(0\)\s*$/.test(tab.textContent)) return null;
    return { blankslate, query: new URL(tab.href).searchParams.get("q") ?? "" };
  }

  function updateCelebration() {
    const empty = isPrListPage() && isOn("celebration") ? emptyList() : null;
    const wanted = empty && isWaitingQuery(empty.query) ? empty : null;
    const key = wanted?.query;
    const showing =
      celebration.root?.isConnected &&
      celebration.root.nextElementSibling === wanted?.blankslate;
    if (showing && celebration.key === key) return;
    celebration.stop?.();
    Object.assign(celebration, { stop: null, root: null, key: null });
    if (!wanted) return;
    if (!celebrationEffects.has(key))
      celebrationEffects.set(key, pickOne(Object.keys(CELEBRATIONS)));
    celebration.stop = celebrate(wanted.blankslate, {
      effect: celebrationEffects.get(key),
    });
    celebration.root = wanted.blankslate.previousElementSibling;
    celebration.key = key;
  }

  // Runs on all of github.com because GitHub navigates between pages without a full reload.
  function isPrListPage() {
    return (
      /^\/pulls(\/|$)/.test(location.pathname) ||
      /^\/[^/]+\/[^/]+\/pulls(\/|$)/.test(location.pathname)
    );
  }

  function highlight() {
    if (!isPrListPage()) {
      if (activeTicket.key) setActiveTicket(null);
      updateCelebration();
      return;
    }

    // New preview experience: rows are <li> ancestors of the timestamp container.
    // We use the first relative-time in the container, which is the "opened" date.
    const rows = listRows();
    rows.forEach((row) => {
      const timeEl = row.querySelector(
        '[data-testid="timestamp-container"] relative-time',
      );
      if (!timeEl) return;
      applyHighlight(row, timeEl);
      applyAuthorHighlight(row);
      addBadges(row);
    });
    applyTicketKeys(rows);
    watchDraftStripes(rows[0]?.parentElement);
    addFooter();
    // Runs on every change GitHub makes, so the author list rebuilds only when the page's authors change.
    if (renderedAuthors !== authorSignature(rows)) renderPanel();
    updateCelebration();
  }

  // Each draft row's stripes are shifted by its place in the list, so they run unbroken across
  // neighboring drafts. A row above growing, such as when its badges wrap the title, resizes the list.
  let stripeList = null;
  const stripeObserver = new ResizeObserver(alignDraftStripes);
  function watchDraftStripes(list) {
    if (list !== stripeList) {
      if (stripeList) stripeObserver.unobserve(stripeList);
      stripeList = list;
      if (list) stripeObserver.observe(list);
    }
    alignDraftStripes();
  }
  function alignDraftStripes() {
    document.querySelectorAll("li.prb-draft").forEach((row) => {
      const y =
        row.parentElement.getBoundingClientRect().top -
        row.getBoundingClientRect().top;
      if (row.prbStripeY === y) return;
      row.prbStripeY = y;
      row.style.backgroundPosition = `0 ${y}px`;
    });
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

  // The script's own renders would otherwise rerun highlight() after every badge update. Removals
  // always count, since that's how a GitHub redraw that drops the badges shows up.
  const OWN_NODES =
    ".prb-group, .prb-reviews, .prb-ticket, .prb-tg-arrow, #prb-footer, .prb-cel, .prb-bubble";
  function isOwnNode(node) {
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return !!el?.closest(OWN_NODES);
  }
  function isOwnMutation(record) {
    if (isOwnNode(record.target)) return true;
    return (
      !record.removedNodes.length && [...record.addedNodes].every(isOwnNode)
    );
  }

  highlight();
  new MutationObserver((records) => {
    if (!records.every(isOwnMutation)) queueHighlight();
  }).observe(document.body, {
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
