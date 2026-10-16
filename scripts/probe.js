// Drift probe for GitHub PR List Status. Checks that the GitHub internals the userscript depends on
// still look the way AGENTS.md describes. Run it on a logged-in github.com pull request list, either
// pasted into the browser console or injected by an agent. It changes nothing and makes at most 7
// requests. Results print as a table and are also the value of the expression.
(async () => {
  const results = [];
  const report = (area, check, status, detail = "") =>
    results.push({ area, check, status, detail });
  const pass = (area, check, detail) => report(area, check, "PASS", detail);
  const fail = (area, check, detail) => report(area, check, "FAIL", detail);
  const skip = (area, check, detail) => report(area, check, "SKIP", detail);
  const expect = (area, check, ok, detail) =>
    (ok ? pass : fail)(area, check, detail);
  const done = () => {
    console.table(results);
    const failed = results.filter((r) => r.status === "FAIL").length;
    console.log(
      failed
        ? `${failed} check(s) failed`
        : "No drift found in what this page exercises",
    );
    return results;
  };

  const login = document.querySelector('meta[name="user-login"]')?.content;
  expect("session", "Signed in (meta user-login)", !!login, login || "");
  if (!login) return done();

  const listPath =
    /^\/pulls(\/|$)/.test(location.pathname) ||
    /^\/[^/]+\/[^/]+\/pulls(\/|$)/.test(location.pathname);
  expect("session", "On a PR list path", listPath, location.pathname);
  if (!listPath) return done();

  expect(
    "page",
    "data-color-mode on <html>",
    !!document.documentElement.dataset.colorMode,
    document.documentElement.dataset.colorMode || "",
  );

  const rows = [
    ...document.querySelectorAll('[data-testid="timestamp-container"]'),
  ]
    .map((container) => container.closest("li"))
    .filter(Boolean);
  expect(
    "page",
    "Rows via timestamp-container > li",
    rows.length > 0,
    `${rows.length} rows`,
  );
  if (!rows.length) return done();

  const links = rows.map((row) =>
    row.querySelector('a[data-testid="listitem-title-link"]'),
  );
  const linked = links.filter(Boolean).length;
  expect(
    "page",
    "Title link in every row",
    linked === rows.length,
    `${linked} of ${rows.length}`,
  );

  const headings = links.map((link) => link?.closest("h1, h2, h3, h4, h5, h6"));
  const inlineHeadings = headings.filter(
    (h) => h && getComputedStyle(h).display.startsWith("inline"),
  ).length;
  const levels = [...new Set(headings.filter(Boolean).map((h) => h.tagName))];
  expect(
    "page",
    "Title link inside an inline heading",
    inlineHeadings === linked,
    `${inlineHeadings} of ${linked} (${levels.join(", ") || "none"})`,
  );

  const plainTitles = links.filter((link) => {
    const texts = [];
    const walker = document.createTreeWalker(link || document, 4);
    for (let node = walker.nextNode(); node; node = walker.nextNode())
      if (node.data.trim()) texts.push(node);
    return (
      link && texts.length === 1 && texts[0].parentNode.childNodes.length === 1
    );
  }).length;
  expect(
    "page",
    "Plain titles are one lone text node",
    plainTitles > 0,
    `${plainTitles} of ${linked} titles (code-formatted titles are expected to differ)`,
  );

  const authors = rows.filter((row) =>
    row
      .querySelector('[data-testid="author-filter-link"]')
      ?.getAttribute("aria-label")
      ?.startsWith("Filter by author"),
  ).length;
  expect(
    "page",
    'Author aria-label "Filter by author …"',
    authors === rows.length,
    `${authors} of ${rows.length}`,
  );

  const attributed = rows.filter((row) =>
    row.querySelector('[data-testid="attributed-author-filter-link"]'),
  ).length;
  (attributed ? pass : skip)(
    "page",
    "Copilot attributed author link",
    attributed ? `${attributed} rows` : "No Copilot PRs on this page",
  );

  const comments = rows.filter((row) =>
    row.querySelector("svg.octicon-comment"),
  ).length;
  (comments ? pass : skip)(
    "page",
    "Comment count icon (svg.octicon-comment)",
    comments ? `${comments} rows` : "No rows with comments on this page",
  );

  const areas = ["primary", "main-content", "metadata"];
  const gridRows = rows.filter((row) =>
    areas.every((area) =>
      [...row.children].some((el) =>
        getComputedStyle(el).gridArea.includes(area),
      ),
    ),
  ).length;
  expect(
    "page",
    "Grid areas primary, main-content, metadata",
    gridRows === rows.length,
    `${gridRows} of ${rows.length}`,
  );

  const STATES = {
    "octicon-git-pull-request": "open",
    "octicon-git-pull-request-draft": "draft",
    "octicon-git-merge": "merged",
    "octicon-git-pull-request-closed": "closed",
  };
  const stateOf = (row) => {
    const icon = row.querySelector("svg");
    return Object.entries(STATES).find(([name]) =>
      icon?.classList.contains(name),
    )?.[1];
  };
  const states = rows.map(stateOf);
  const counts = {};
  states.forEach((s) => {
    counts[s || "unrecognized"] = (counts[s || "unrecognized"] || 0) + 1;
  });
  expect(
    "page",
    "First svg in each row is a known state icon",
    !counts.unrecognized,
    JSON.stringify(counts),
  );

  // GitHub inserts the review decisions several seconds after the rows.
  const decisionIcons = () =>
    rows
      .map((row) => row.querySelector('[data-testid="review-decision-icon"]'))
      .filter(Boolean);
  for (let i = 0; i < 20 && !decisionIcons().length; i++)
    await new Promise((resolve) => setTimeout(resolve, 500));
  const decisions = decisionIcons();
  const decisionTexts = [
    ...new Set(decisions.map((icon) => icon.textContent.replace(/^·/, ""))),
  ];
  if (!decisions.length)
    skip("page", "Review decision icon", "None appeared within 10 seconds");
  else
    expect(
      "page",
      "Review decision icon reads Approved or Review required",
      decisionTexts.some((t) => /Approved|Review required/.test(t)),
      `${decisions.length} rows: ${decisionTexts.join(", ")}`,
    );

  const openRow = rows[states.indexOf("open")];
  if (!openRow) {
    skip("endpoints", "All page_data endpoints", "No open PR on this page");
  } else {
    const prPath = new URL(
      openRow.querySelector('a[data-testid="listitem-title-link"]').href,
    ).pathname;
    const get = async (endpoint) => {
      try {
        const response = await fetch(`${prPath}/page_data/${endpoint}`, {
          headers: {
            Accept: "application/json",
            "X-Requested-With": "XMLHttpRequest",
          },
          credentials: "same-origin",
        });
        if (!response.ok) return { error: `HTTP ${response.status}` };
        return { data: await response.json() };
      } catch (error) {
        return { error: error.message };
      }
    };
    const isArray = (value) => Array.isArray(value);
    const firstOk = (list, test) => !list?.length || test(list[0]);
    const shapes = {
      diffstat: (d) =>
        typeof d.diffstat?.linesAdded === "number" &&
        typeof d.diffstat?.linesDeleted === "number",
      file_tree: (d) =>
        isArray(d.diffs) && firstOk(d.diffs, (f) => "path" in f),
      "merge_box?merge_method=MERGE&bypass_requirements=false": (d) => {
        const pr = d.pullRequest;
        return (
          typeof pr?.state === "string" &&
          typeof pr.mergeStateStatus === "string" &&
          isArray(pr.latestOpinionatedReviews) &&
          firstOk(
            pr.latestOpinionatedReviews,
            (r) => r.state && r.author?.login,
          ) &&
          isArray(pr.pendingReviewRequests)
        );
      },
      status_checks: (d) =>
        isArray(d.statusChecks) &&
        firstOk(d.statusChecks, (c) => c.displayName && c.state),
      participants: (d) =>
        isArray(d.participants) &&
        firstOk(d.participants, (p) => p.displayLogin),
      threads: (d) =>
        isArray(d.threads) &&
        firstOk(
          d.threads,
          (t) =>
            typeof t.isResolved === "boolean" &&
            "reviewCommentsLimitExceeded" in t &&
            firstOk(
              t.commentsData?.comments,
              (c) =>
                typeof c.viewerDidAuthor === "boolean" &&
                isArray(c.reactionGroups),
            ),
        ),
    };
    for (const [endpoint, shape] of Object.entries(shapes)) {
      const name = endpoint.split("?")[0];
      const { data, error } = await get(endpoint);
      if (error) fail("endpoints", name, `${prPath}: ${error}`);
      else
        expect(
          "endpoints",
          name,
          shape(data),
          shape(data)
            ? prPath
            : `Fields changed: ${Object.keys(data).join(", ")}`,
        );
    }
  }

  try {
    const response = await fetch("/pulls?q=is%3Apr", {
      credentials: "same-origin",
    });
    const landed = new URL(response.url).pathname;
    expect(
      "navigation",
      "/pulls?q= lands on a PR list path",
      response.ok && /^\/pulls(\/|$)/.test(landed),
      landed,
    );
  } catch (error) {
    fail("navigation", "/pulls?q= lands on a PR list path", error.message);
  }

  return done();
})();
