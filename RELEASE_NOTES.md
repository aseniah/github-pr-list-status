# Release Notes

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
