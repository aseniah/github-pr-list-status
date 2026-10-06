# AGENTS.md

A single-file userscript, `github-pr-list-status.user.js`, that adds merge state, line count, and review badges to GitHub's pull request lists. There is no build, no dependencies, and no test suite. `docs/demo.html` is a static mockup of the list served by GitHub Pages.

## Volatile by design

The script runs on GitHub internals that are undocumented and change without notice, so any GitHub release can break it. Treat every name below as a snapshot: before changing behavior that touches one, probe the live page or response and confirm it still holds. Every failure path degrades to a row without badges, never to a broken page.

- **Endpoints**, all under `/{owner}/{repo}/pull/{n}/page_data/`: `diffstat`, `file_tree`, `merge_box?merge_method=MERGE&bypass_requirements=false`, `status_checks`, `participants`. They answer 406 without `X-Requested-With: XMLHttpRequest`. `file_tree` omits count fields that are zero. `merge_box` reports `mergeStateStatus: UNKNOWN` while GitHub recomputes mergeability, typically right after the base branch moves. `merge_box` also lists `pendingReviewRequests`, and a reviewer leaves that list when they submit a review.
- **Page structure**: rows are found through `[data-testid="timestamp-container"]`, titles through `a[data-testid="listitem-title-link"]`, the author through the `aria-label` of `[data-testid="author-filter-link"]`, and row regions through the CSS grid areas `primary`, `main-content`, and `metadata`. Theme comes from `data-color-mode` on `<html>`, and the signed-in user from `<meta name="user-login">`.
- **Navigation**: GitHub switches pages without a full reload, which is why `@match` covers all of `github.com/*` and the script gates itself with `isPrListPage()`.

## Demo page

`docs/demo.html` mirrors the script with fictional data (the `acme` org) and is the source for the README screenshot.

- **Prototype here first.** Any visual or layout change starts as a mockup in the demo, gets agreed, and only then moves into the script.
- **Keep it in sync.** Every change to pill labels, layout, colors, or `BADGE_CSS` lands in the demo in the same change. The demo's badge CSS is a copy of `BADGE_CSS` below the `/* Copied from the userscript */` marker. The demo defines GitHub's light and dark variable values and sets `data-color-mode` the way GitHub does, so its theme toggle exercises the script's real CSS.
- **Fictional data only.** Real repository names, people, and screenshots of real GitHub pages stay out of the repo, since it is public.

## Verifying a change

1. `node --check github-pr-list-status.user.js` passes.
2. Logic changes are exercised against sample data in Node, for example by extracting `statePills` with `new Function`.
3. Behavior and layout changes are confirmed on a logged-in `github.com/pulls` page by injecting the script body into the page, then checking the rendered badges against `gh api graphql` (`mergeStateStatus`, `additions`, `reviewDecision`). The change is done when the badges match GitHub's own data and the layout holds in both light and dark mode.

## Conventions

- User-facing settings live in the static `CONFIG` block at the top of the script, and each one is documented under Configuration in `README.md`.
- User-facing changes update the README's Features and Configuration sections and bump `@version`.
- `RELEASE_NOTES.md` covers only what changes for someone running the script. Updates to the demo, screenshots, or docs stay out of it.
