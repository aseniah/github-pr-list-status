const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

// Pulls the celebration code out of the script by its surrounding lines, so it's tested as written.
const source = readFileSync(
  join(__dirname, "..", "github-pr-list-status.user.js"),
  "utf8",
);
const from = source.indexOf("  // ---------- Empty list celebration");
const to = source.indexOf("  // Runs on all of github.com", from);
assert.ok(from >= 0 && to > from, "celebration code markers not found");
const {
  CELEBRATIONS,
  CELEBRATION_MESSAGES,
  celebrationSeason,
  celebratedYear,
  isWaitingQuery,
} = new Function(
  `${source.slice(from, to)}; return { CELEBRATIONS, CELEBRATION_MESSAGES, celebrationSeason, celebratedYear, isWaitingQuery };`,
)();

const SEASONS = [
  "base",
  "halloween",
  "thanksgiving",
  "winter",
  "newyear",
  "valentine",
  "stpatrick",
  "summer",
];

test("season boundaries", () => {
  const cases = [
    ["2026-09-30", "base"],
    ["2026-10-01", "halloween"],
    ["2026-10-31", "halloween"],
    ["2026-11-01", "thanksgiving"],
    ["2026-11-30", "thanksgiving"],
    ["2026-12-01", "winter"],
    ["2026-12-31", "winter"],
    ["2027-01-01", "newyear"],
    ["2027-01-07", "newyear"],
    ["2027-01-08", "base"],
    ["2027-01-31", "base"],
    ["2027-02-01", "valentine"],
    ["2027-02-14", "valentine"],
    ["2027-02-15", "base"],
    ["2027-03-09", "base"],
    ["2027-03-10", "stpatrick"],
    ["2027-03-17", "stpatrick"],
    ["2027-03-18", "base"],
    ["2027-06-20", "base"],
    ["2027-06-21", "summer"],
    ["2027-08-31", "summer"],
    ["2027-09-01", "base"],
  ];
  for (const [day, season] of cases) {
    const [y, m, d] = day.split("-").map(Number);
    assert.equal(celebrationSeason(new Date(y, m - 1, d)), season, day);
  }
});

test("the celebrated year is the coming one, or this one in January", () => {
  assert.equal(celebratedYear(new Date(2026, 9, 24)), 2027);
  assert.equal(celebratedYear(new Date(2026, 11, 31)), 2027);
  assert.equal(celebratedYear(new Date(2027, 0, 3)), 2027);
});

test("every effect covers every season with a message", () => {
  assert.deepEqual(
    Object.keys(CELEBRATION_MESSAGES).sort(),
    Object.keys(CELEBRATIONS).sort(),
  );
  for (const [effect, [render, seasons]] of Object.entries(CELEBRATIONS)) {
    assert.equal(typeof render, "function", effect);
    for (const season of SEASONS) {
      assert.ok(seasons[season], `${effect} has no ${season} entry`);
      const message = CELEBRATION_MESSAGES[effect][season];
      assert.ok(
        Array.isArray(message) &&
          message.length === 2 &&
          message.every((line) => typeof line === "string" && line.trim()),
        `${effect}/${season} message`,
      );
    }
  }
});

test("celebrates lists of PRs waiting on you", () => {
  const waiting = [
    "state:open is:pr review-requested:@me archived:false sort:updated-desc",
    "is:open is:pr review-requested:@me archived:false -review:approved draft:false -repo:acme/infra -repo:acme/infra-federal",
    "is:pr assignee:@me state:open archived:false sort:updated-desc",
    "is:pr involves:@me state:open archived:false sort:updated-desc",
    "is:open mentions:@me",
    "is:open user-review-requested:@me",
    "is:open repo:acme/web label:bug review-requested:@me",
  ];
  for (const q of waiting) assert.equal(isWaitingQuery(q), true, q);
});

test("doesn't celebrate other lists", () => {
  const other = [
    "is:pr author:@me state:open",
    "is:pr is:open",
    "is:pr state:open repo:acme/web label:bug",
    "is:pr review-requested:@me state:closed",
    "is:open is:closed review-requested:@me",
    "is:merged review-requested:@me",
    "is:open -review-requested:@me",
    "is:pr review-requested:@me",
    'is:open "review-requested:@me"',
    "is:open review-requested:octocat",
    "is:open review-requested:@meow",
    "",
  ];
  for (const q of other) assert.equal(isWaitingQuery(q), false, q);
});
