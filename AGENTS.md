# AGENTS.md

A single-file userscript, `github-pr-list-status.user.js`, that adds merge state, line count, and review badges to GitHub's pull request lists. There is no build, no dependencies, and no test suite. `docs/demo.html` is a static mockup of the list served by GitHub Pages.

## Volatile by design

The script runs on GitHub internals that are undocumented and change without notice, so any GitHub release can break it. Treat every name below as a snapshot: before changing behavior that touches one, probe the live page or response and confirm it still holds. Every failure path degrades to a row with fewer badges, never to a broken page, and a failed request marks the row ⚠ with its reason.

- **Endpoints**, all under `/{owner}/{repo}/pull/{n}/page_data/`: `diffstat`, `file_tree`, `merge_box?merge_method=MERGE&bypass_requirements=false`, `status_checks`, `participants`, `threads`. They answer 406 without `X-Requested-With: XMLHttpRequest`. `file_tree` omits count fields that are zero. `merge_box` reports `mergeStateStatus: UNKNOWN` while GitHub recomputes mergeability, typically right after the base branch moves, and indefinitely for merged PRs, so the script reads `pullRequest.state` and skips merge state for anything not `OPEN`. `merge_box` also lists `pendingReviewRequests`, and a reviewer leaves that list when they submit a review. `threads` returns every review thread with `isResolved` and at most 20 comments each (`reviewCommentsLimitExceeded` flags longer threads), and each comment carries `viewerDidAuthor` and `reactionGroups[].reaction.viewerHasReacted`.
- **Page structure**: rows are found through `[data-testid="timestamp-container"]`, titles through `a[data-testid="listitem-title-link"]`, the author through the `aria-label` of `[data-testid="author-filter-link"]` (PRs opened with Copilot show Copilot there and the person in `[data-testid="attributed-author-filter-link"]` before "with"), comments through `svg.octicon-comment`, which GitHub leaves out when the count (conversation comments, review bodies, and thread comments) is zero, and row regions through the CSS grid areas `primary`, `main-content`, and `metadata`. Theme comes from `data-color-mode` on `<html>`, and the signed-in user from `<meta name="user-login">`. The author element is currently an underlined, inline-block `button` showing "Full Name (login)", and highlighted authors get the `prb-hl` chip classes on it directly, so GitHub's own styles for it compete with the chip CSS.
- **Edges GitHub already uses**: unread rows get a 3px blue `::before` on the row's left edge from an `UnreadBorder-module__unreadBorder__*` class on the `li`, which is why highlighting avoids row edges.
- **Navigation**: GitHub switches pages without a full reload, which is why `@match` covers all of `github.com/*` and the script gates itself with `isPrListPage()`. Opening a PR from the list is a full page load, though, and Back restores the frozen list from the browser's back-forward cache (confirmed in Chrome), so the script refreshes the opened PR on `pageshow`.

## Demo page

`docs/demo.html` mirrors the script with fictional data (the `acme` org) and is the source for the README screenshot.

- **Prototype here first.** Any visual or layout change starts as a mockup in the demo, gets agreed, and only then moves into the script.
- **Keep it in sync.** Every change to pill labels, layout, colors, or `BADGE_CSS` lands in the demo in the same change. The demo's badge CSS is a copy of `BADGE_CSS` below the `/* Copied from the userscript */` marker. The demo defines GitHub's light and dark variable values and sets `data-color-mode` the way GitHub does, so its theme toggle exercises the script's real CSS.
- **Fictional data only.** Real repository names, people, and screenshots of real GitHub pages stay out of the repo, since it is public.

## Verifying a change

1. `node --check github-pr-list-status.user.js` passes.
2. Logic changes are exercised against sample data in Node, for example by extracting `statePills` with `new Function`.
3. Behavior and layout changes are confirmed on a logged-in `github.com/pulls` page by injecting the script body into the page (GitHub's CSP blocks `eval` and inline scripts, so pass the source as the injected code itself), then checking the rendered badges against `gh api graphql` (`mergeStateStatus`, `additions`, `reviewDecision`). The change is done when the badges match GitHub's own data and the layout holds in both light and dark mode.

## Conventions

- Feature toggles and highlighted authors live in the settings panel and are stored in `localStorage` under `prb-settings` (`@grant none`, no GM storage), keeping only values that differ from the defaults. Everything else lives in the static `CONFIG` block at the top of the script, which also supplies some panel defaults. Each setting is documented under Configuration in `README.md`.
- GitHub's global CSS styles some bare class names (Primer's `.Label, .label` draws a pill border), so new classes get the `prb-` prefix. The demo doesn't load GitHub's CSS, so these collisions only show on the live page.
- GitHub's CSP blocks inline event handlers, so script UI is built with `createElement` and `addEventListener`. Author names come from the page and go in through `textContent`, never `innerHTML`.
- Every panel feature maps to the endpoints it needs in `loadPrInfo`, and **Fewer requests** must stay at `diffstat` plus `merge_box`, since the README and the panel's info popup promise two requests per PR.
- User-facing changes update the README's Features and Configuration sections and bump `@version`.
- `RELEASE_NOTES.md` covers only what changes for someone running the script. Updates to the demo, screenshots, or docs stay out of it.
