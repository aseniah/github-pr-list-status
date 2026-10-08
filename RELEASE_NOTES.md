# Release Notes

## 1.4

- **Settings panel.** The full-width legend bar is gone. Below the list, **Settings** and **Legend** each open their own panel, and the load-failure message shares that line. Settings are saved in the browser, so they survive updates and apply to every GitHub tab. The **PR List Status** label next to them links to the project.
- **Highlighted authors.** Pick authors from the PRs on the page and their names show in a gray chip on every list. Switch the chip to an animated 🌈 rainbow if you want them to stand out more. Saved authors stay listed in the panel even when they have no PRs on the page, so you can remove them.
- **Feature toggles.** Turn row colors, merge state, check details, line counts, lockfile filtering, review counts, commenters, and waiting threads on or off one at a time. Turning off a feature also skips the requests only it needs.
- **Fewer requests preset.** One click turns off the features that cost extra requests, cutting each PR from up to five requests to two. Badges load sooner and long lists are less likely to hit GitHub's rate limit. Failing checks then show as **✗ Failing** without a count. **Enable all** turns everything back on.
- **Defaults from CONFIG.** `excludeLockfiles` and `flagWaitingThreads` now set the defaults for their panel toggles. Anything you change in the panel takes precedence.

## 1.3.1

- **Fresh checks when you return.** Switching back to the PR list tab refetches **● Checking…** rows right away if their once a minute refetch was missed while the tab was hidden, instead of waiting up to another minute.

## 1.3

### Features

- **Threads waiting on you.** On PRs you opened, a blue reply icon with a count marks unresolved review threads where someone else had the last word and you haven't replied or reacted. Resolving the thread, replying, or reacting to its latest comment clears it. Turn it off with `flagWaitingThreads`.
- **Load failures are visible.** A row that didn't fully load shows a ⚠ with the reason on hover, and a line under the list counts those rows with a Retry button. A rate limit from GitHub stops all requests until you retry or reload.

### Fixes

- **Fresh data on reload.** Reloading the page now always fetches fresh badges instead of reusing results from the last minute.
- **Fresh data after Back.** Opening a PR from the list and returning with the Back button refetches that PR.
- **Merged and closed PRs.** These rows now show only line and review counts. They no longer get stuck on **● Checking…** or refetch every minute.

## 1.2

- **Re-review requests.** When you've reviewed or commented on a PR and the author asks for your review again, a blue eye appears at the start of its review counts. Hover for details. The legend explains it too.

## 1.1.1

- **Tidier legend.** Each legend column now sizes to its content, so descriptions stay on one line at full width. Badges and swatches line up with the first line of their description, keeping spacing even when text does wrap. The Checking description is also shorter.

## 1.1

- **Legend.** A collapsible legend at the bottom of the pull request list explains each row color, including uncolored rows, along with every badge and review count.
- **Automatic updates.** Userscript managers now pick up new releases on their own. See the README for how to turn this off if you edit the settings.

## 1.0

Initial release.

- Badges for each PR's merge state: Ready, Behind, Conflicts, failing checks, Checking, and Blocked.
- A line count badge showing lines added and deleted, with lockfiles left out by default.
- Review counts for approvals, change requests, and commenters under GitHub's comment count.
- Row colors that mark approved PRs green and age unapproved PRs from yellow to orange to red.
- Automatic refresh for PRs whose checks are still running.
- Custom badges for named checks such as a deploy gate.
- Light and dark mode support that follows GitHub's theme.
- No token or setup, since it uses your existing GitHub login.
