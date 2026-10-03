// ==UserScript==
// @name        GitHub PR List Status
// @namespace   https://github.com/aseniah
// @description Colors PRs by age and approval, and adds merge state and line count badges to the pull requests list
// @version     1.5
// @license     MIT
// @match       https://github.com/*
// @run-at      document-idle
// ==/UserScript==

(function () {
  const CONFIG = {
    // Row color for unapproved PRs, by age. The first entry the PR is younger than wins.
    // Any CSS color works. The defaults are GitHub theme variables so they follow light and dark mode.
    ageColors: [
      { days: 7,        color: 'transparent' },                    // < 1 week: no highlight
      { days: 14,       color: 'var(--bgColor-attention-muted)' }, // 1–2 weeks: yellow
      { days: 30,       color: 'var(--bgColor-severe-muted)' },    // 2–4 weeks: orange
      { days: Infinity, color: 'var(--bgColor-danger-muted)' },    // > 1 month: red
    ],
    approvedColor: 'var(--bgColor-success-muted)', // green

    // A failing check matching one of these gets its own badge instead of counting toward "N failing".
    // match: exact check name or a RegExp. style: purple, blue, red, yellow, gray, or green.
    namedChecks: [
      { match: 'Release Check', label: '🔒 Pipeline', style: 'purple' },
    ],

    // People matching these are left out of the review counts. match: exact login or a RegExp.
    ignoredReviewers: [/\[bot\]$/i, /^copilot/i],

    // Leave lockfiles out of the line counts so dependency upgrades show the reviewable size.
    excludeLockfiles: true,
    lockfilePattern: /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Gemfile\.lock|Cargo\.lock|composer\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|go\.sum|flake\.lock)$/,

    // Reloading the page within this window reuses earlier results.
    cacheMinutes: 1,
    // While the tab is visible, PRs showing "Checking…" refetch this often. Other badges update on reload.
    checkingRefreshSeconds: 60,
    maxConcurrentPrs: 4,
  };

  // Undocumented endpoints the PR page itself calls. They return 406 without X-Requested-With.
  const PAGE_DATA_HEADERS = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
  const CACHE_TTL_MS = CONFIG.cacheMinutes * 60 * 1000;
  const STYLE_CLASSES = {
    purple: 'prb-release', blue: 'prb-blue', red: 'prb-failing', yellow: 'prb-behind', gray: 'prb-blocked', green: 'prb-ready',
  };
  const PASSING_CHECK_STATES = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
  const FAILING_CHECK_STATES = new Set([
    'FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE',
  ]);

  // Primer octicon comment-discussion-16 (MIT). Two bubbles, so it doesn't read as GitHub's comment count.
  const DISCUSSION_ICON_PATH = 'M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z';

  const BADGE_CSS = `
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
  `;

  function getColor(date) {
    const ageDays = (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24);
    return CONFIG.ageColors.find(t => ageDays < t.days)?.color ?? 'transparent';
  }

  function isApproved(row) {
    // Old experience: text like "Approved" often sits in a span near the status area
    const reviewIcon = row.querySelector('[data-testid="review-decision-icon"]');
    if (reviewIcon && reviewIcon.textContent.includes('Approved')) return true;

    // Fallback: search any element with an aria-label mentioning Approved,
    // or plain text "Approved" inside the row (old UI sometimes just has a label/span)
    const ariaMatch = row.querySelector('[aria-label*="Approved"]');
    if (ariaMatch) return true;

    return Array.from(row.querySelectorAll('span, div')).some(
      el => el.textContent.trim() === 'Approved'
    );
  }

  function applyHighlight(row, timeEl) {
    const datetime = timeEl.getAttribute('datetime');
    if (!datetime) return;

    const color = isApproved(row) ? CONFIG.approvedColor : getColor(new Date(datetime));
    row.style.backgroundColor = color;
    row.style.transition = 'background-color 0.2s';
  }

  const memoryCache = new Map();
  const queue = [];
  let activeCount = 0;

  function schedule(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      pumpQueue();
    });
  }

  function pumpQueue() {
    while (activeCount < CONFIG.maxConcurrentPrs && queue.length) {
      const { task, resolve, reject } = queue.shift();
      activeCount++;
      task().then(resolve, reject).finally(() => {
        activeCount--;
        pumpQueue();
      });
    }
  }

  async function fetchPageData(prPath, endpoint) {
    const response = await fetch(`${prPath}/page_data/${endpoint}`, {
      headers: PAGE_DATA_HEADERS,
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error(`${endpoint} returned ${response.status}`);
    return response.json();
  }

  async function loadLineCounts(prPath) {
    if (CONFIG.excludeLockfiles) {
      const tree = await fetchPageData(prPath, 'file_tree');
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
    const { diffstat } = await fetchPageData(prPath, 'diffstat');
    return { linesAdded: diffstat.linesAdded, linesDeleted: diffstat.linesDeleted, excludedLines: 0 };
  }

  async function loadPrInfo(prPath) {
    const [lines, mergeBox, checks, participants] = await Promise.all([
      loadLineCounts(prPath),
      fetchPageData(prPath, 'merge_box?merge_method=MERGE&bypass_requirements=false'),
      fetchPageData(prPath, 'status_checks'),
      fetchPageData(prPath, 'participants').catch(() => ({ participants: [] })),
    ]);
    const reviews = mergeBox.pullRequest.latestOpinionatedReviews || [];
    const reviewersWithState = state => reviews.filter(r => r.state === state).map(r => r.author.login);
    return {
      ...lines,
      approvedBy: reviewersWithState('APPROVED'),
      changesRequestedBy: reviewersWithState('CHANGES_REQUESTED'),
      participants: (participants.participants || []).map(p => p.displayLogin),
      mergeStateStatus: mergeBox.pullRequest.mergeStateStatus,
      checks: (checks.statusChecks || []).map(c => ({
        name: c.displayName,
        state: c.state,
        description: c.description,
      })),
    };
  }

  function getPrInfo(prPath, { fresh = false } = {}) {
    if (!fresh && memoryCache.has(prPath)) return memoryCache.get(prPath);

    const storageKey = `prb2:${CONFIG.excludeLockfiles ? 'nolock' : 'all'}:${prPath}`;
    try {
      const stored = !fresh && JSON.parse(sessionStorage.getItem(storageKey));
      if (stored && Date.now() - stored.at < CACHE_TTL_MS) {
        const cached = Promise.resolve(stored.info);
        memoryCache.set(prPath, cached);
        return cached;
      }
    } catch (_) { /* unreadable cache entry, refetch */ }

    const pending = schedule(() => loadPrInfo(prPath)).then(info => {
      try {
        if (!isUnresolved(info)) sessionStorage.setItem(storageKey, JSON.stringify({ at: Date.now(), info }));
      } catch (_) { /* storage full or blocked */ }
      setTimeout(() => memoryCache.delete(prPath), CACHE_TTL_MS);
      return info;
    });
    pending.catch(() => memoryCache.delete(prPath));
    memoryCache.set(prPath, pending);
    return pending;
  }

  function formatCount(n) {
    if (n < 1000) return String(n);
    return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  }

  function pill(className, text, tooltip) {
    const el = document.createElement('span');
    el.className = `prb ${className}`;
    el.textContent = text;
    if (tooltip) el.title = tooltip;
    return el;
  }

  function sizePill(info) {
    const excluded = info.excludedLines ? `\n${info.excludedLines} lockfile lines not counted` : '';
    const el = pill('prb-size', '', `+${info.linesAdded} added, −${info.linesDeleted} deleted${excluded}`);
    const add = document.createElement('span');
    add.className = 'add';
    add.textContent = `+${formatCount(info.linesAdded)}`;
    const del = document.createElement('span');
    del.className = 'del';
    del.textContent = `−${formatCount(info.linesDeleted)}`;
    el.append(add, ' ', del);
    return el;
  }

  // GitHub reports UNKNOWN while it recomputes mergeability, e.g. right after the base branch moves.
  function isUnresolved(info) {
    return info.mergeStateStatus === 'UNKNOWN' || info.checks.some(isPending);
  }

  function isPending(check) {
    return !PASSING_CHECK_STATES.has(check.state) && !FAILING_CHECK_STATES.has(check.state);
  }

  function checkMatches(match, name) {
    return match instanceof RegExp ? match.test(name) : match === name;
  }

  function statePills(info, approved) {
    const pills = [];
    const failing = info.checks.filter(c => FAILING_CHECK_STATES.has(c.state));
    const namedMatches = CONFIG.namedChecks
      .map(rule => ({ rule, checks: failing.filter(c => checkMatches(rule.match, c.name)) }))
      .filter(m => m.checks.length);
    const otherFailing = failing.filter(c => !namedMatches.some(m => m.checks.includes(c)));
    const pending = info.checks.filter(isPending);

    if (info.mergeStateStatus === 'DIRTY') {
      pills.push(pill('prb-conflict', '⚠ Conflicts', 'Merge conflict with the base branch'));
    }
    namedMatches.forEach(({ rule, checks }) => {
      pills.push(pill(STYLE_CLASSES[rule.style] || STYLE_CLASSES.gray, rule.label,
        checks.map(c => `${c.name}: ${c.description || 'failing'}`).join('\n')));
    });
    if (otherFailing.length) {
      pills.push(pill('prb-failing', `✗ ${otherFailing.length} failing`, `Failing: ${otherFailing.map(c => c.name).join(', ')}`));
    }
    if (pending.length || info.mergeStateStatus === 'UNKNOWN') {
      const tooltip = pending.length
        ? `Pending: ${pending.map(c => c.name).join(', ')}`
        : 'GitHub is still checking whether this can merge';
      const checking = pill('prb-running', '● Checking', tooltip);
      const dots = document.createElement('span');
      dots.className = 'prb-dots';
      dots.append(...[0, 1, 2].map(() => Object.assign(document.createElement('span'), { textContent: '.' })));
      checking.append(dots);
      pills.push(checking);
    }
    if (info.mergeStateStatus === 'BEHIND') {
      pills.push(pill('prb-behind', '↻ Behind', 'Branch is behind the base branch and needs updating'));
    }

    const clean = info.mergeStateStatus === 'CLEAN' || info.mergeStateStatus === 'HAS_HOOKS';
    if (!pills.length && clean) {
      pills.push(pill('prb-ready', '✓ Ready', 'Approved, checks passing, up to date'));
    }
    // GitHub already shows "Review required" for unapproved PRs, so only flag blocks it doesn't explain.
    if (!pills.length && info.mergeStateStatus === 'BLOCKED' && approved) {
      pills.push(pill('prb-blocked', 'Blocked', 'Approved but blocked by a merge requirement'));
    }
    return pills;
  }

  function prAuthor(row) {
    const label = row.querySelector('[data-testid="author-filter-link"]')?.getAttribute('aria-label') || '';
    // "Filter by author Full Name (login)", or just the login when there's no display name.
    return label.match(/\(([^)]+)\)\s*$/)?.[1] ?? label.replace(/^Filter by author\s+/, '').trim();
  }

  // Approvals and change requests come from each reviewer's latest decision. Anyone else who joined
  // the conversation, other than the author and ignored accounts, counts as a commenter.
  function reviewSummary(info, row) {
    const ignored = login => CONFIG.ignoredReviewers.some(m => checkMatches(m, login));
    const approved = info.approvedBy.filter(l => !ignored(l));
    const changes = info.changesRequestedBy.filter(l => !ignored(l));
    const decided = new Set([...approved, ...changes, prAuthor(row)]);
    const commented = info.participants.filter(l => !decided.has(l) && !ignored(l));
    return [
      { className: 'ok', icon: '✓', label: 'Approved', people: approved },
      { className: 'chg', icon: '✗', label: 'Changes requested', people: changes },
      { className: 'cmt', icon: null, label: 'Commented', people: commented },
    ].filter(part => part.people.length);
  }

  function discussionIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', DISCUSSION_ICON_PATH);
    svg.append(path);
    return svg;
  }

  // Every row gets the second line, even when empty, so the comment count always sits level with the
  // title and the column keeps one width down the list.
  function reviewSlot(row) {
    const metadata = [...row.children].find(el => getComputedStyle(el).gridArea.includes('metadata'));
    if (!metadata) return null;
    let slot = metadata.querySelector(':scope > .prb-reviews');
    if (!slot) {
      slot = document.createElement('span');
      slot.className = 'prb-reviews';
      metadata.classList.add('prb-meta-stack');
      metadata.append(slot);
    }
    return slot;
  }

  function renderReviews(row, info) {
    const slot = reviewSlot(row);
    if (!slot) return;
    const parts = reviewSummary(info, row);
    if (!parts.length) {
      slot.replaceChildren();
      return;
    }
    const el = document.createElement('span');
    el.className = 'prb-review-counts';
    el.title = parts.map(part => `${part.label}: ${part.people.join(', ')}`).join('\n');
    slot.replaceChildren(el);
    el.append(...parts.map(part => {
      const count = document.createElement('span');
      count.className = part.className;
      count.append(part.icon ?? discussionIcon(), String(part.people.length));
      return count;
    }));
  }

  function ensureStyles() {
    if (document.getElementById('prb-styles')) return;
    const style = document.createElement('style');
    style.id = 'prb-styles';
    style.textContent = BADGE_CSS;
    document.head.appendChild(style);
  }

  function addBadges(row) {
    const link = row.querySelector('a[data-testid="listitem-title-link"]');
    const titleContainer = link?.closest('h3')?.parentElement;
    if (!titleContainer) return;

    const prPath = new URL(link.href).pathname;
    if (!/^\/[^/]+\/[^/]+\/pull\/\d+$/.test(prPath)) return;
    const existing = titleContainer.querySelector(':scope > .prb-group');
    if (existing?.dataset.prPath === prPath) {
      // GitHub can redraw the right-hand column on its own, which drops the review counts.
      if (existing.prbInfo && !row.querySelector('.prb-reviews')) renderReviews(row, existing.prbInfo);
      return;
    }
    existing?.remove();

    ensureStyles();
    reviewSlot(row);
    const group = document.createElement('span');
    group.className = 'prb-group';
    group.dataset.prPath = prPath;
    const loading = pill('prb-loading', '', 'Loading merge state and line counts');
    const spinner = document.createElement('span');
    spinner.className = 'prb-spinner';
    loading.appendChild(spinner);
    group.appendChild(loading);
    // Floated, so it has to come before the h3 to sit on the title's first line.
    titleContainer.prepend(group);

    getPrInfo(prPath).then(info => renderBadges(group, row, info), () => group.remove());
  }

  function renderBadges(group, row, info) {
    group.replaceChildren(...statePills(info, isApproved(row)), sizePill(info));
    group.prbInfo = info;
    renderReviews(row, info);
    group.dataset.checking = isUnresolved(info) ? 'true' : 'false';
  }

  function refreshCheckingRows() {
    if (document.visibilityState !== 'visible' || !isPrListPage()) return;
    // Current badges stay up until fresh data replaces them, and stay put if a refetch fails.
    document.querySelectorAll('.prb-group[data-checking="true"]').forEach(group => {
      const row = group.closest('li');
      getPrInfo(group.dataset.prPath, { fresh: true }).then(info => renderBadges(group, row, info), () => {});
    });
  }

  // Runs on all of github.com because GitHub navigates between pages without a full reload.
  function isPrListPage() {
    return /^\/pulls(\/|$)/.test(location.pathname) || /^\/[^/]+\/[^/]+\/pulls(\/|$)/.test(location.pathname);
  }

  function highlight() {
    if (!isPrListPage()) return;

    // Old experience: rows identified by [data-id]
    document.querySelectorAll('[data-id]').forEach(row => {
      const timeEl = row.querySelector('relative-time, time');
      if (timeEl) applyHighlight(row, timeEl);
    });

    // New preview experience: rows are <li> ancestors of the timestamp container.
    // We use the first relative-time in the container, which is the "opened" date.
    document.querySelectorAll('[data-testid="timestamp-container"]').forEach(container => {
      const timeEl = container.querySelector('relative-time');
      if (!timeEl) return;
      const row = container.closest('li');
      if (!row) return;
      applyHighlight(row, timeEl);
      addBadges(row);
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

  highlight();
  new MutationObserver(queueHighlight).observe(document.body, {
    childList: true,
    subtree: true,
  });
  if (CONFIG.checkingRefreshSeconds > 0) {
    setInterval(refreshCheckingRows, CONFIG.checkingRefreshSeconds * 1000);
  }
})();
