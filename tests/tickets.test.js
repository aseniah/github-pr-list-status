const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const root = join(__dirname, "..");

// Pulls the ticket code out of a file by its surrounding lines, so both copies are tested as written.
function extract(file, start, end, names) {
  const source = readFileSync(join(root, file), "utf8");
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `ticket code markers not found in ${file}`);
  return new Function(`${source.slice(from, to)}; return { ${names} };`)();
}

const script = extract(
  "github-pr-list-status.user.js",
  "  // Matches PAY-2210",
  "  function titleLink",
  "findTicket",
);
const demo = extract(
  "docs/demo.html",
  "  // A space separator needs",
  "  // Keys that repeat",
  "findTicket",
);
const { ticketSearchUrl } = extract(
  "github-pr-list-status.user.js",
  "  // GitHub search matches",
  "  // Hovering a shared key",
  "ticketSearchUrl",
);

const CASES = [
  // Formats
  ["feat(PAY-2210): Add a currency filter", "PAY-2210"],
  ["pay_2210 add a currency filter", "PAY-2210"],
  ["Feature/pay 2210 currency filter", "PAY-2210"],
  ["[PAY-2210] Add a currency filter", "PAY-2210"],
  ["VULN-71 Patch the parser", "VULN-71"],
  ["PAY-2210.", "PAY-2210"],
  ["PAY-2210-followup", "PAY-2210"],
  // Underscores next to the key
  ["pay_2210_v2", "PAY-2210"],
  ["PAY-2210_fix", "PAY-2210"],
  ["feature_pay_2210", "PAY-2210"],
  // Not keys
  ["Bump node from 20 to 22", null],
  ["chore: Bump Node to 22", null],
  ["utf-8 decode", null],
  ["Release v1.2.3", null],
  ["PAY2210", null],
  ["fix CVE-2024-1234 in lodash", null],
  ["ABC-1234-5678 cleanup", null],
  ["Upgrade to ubuntu-22.04", null],
  // Known false positives
  ["Target release 2026", "RELEASE-2026"],
  ["Use SHA-256 hashes", "SHA-256"],
  // The most key-like match wins
  ["Return 404 for PAY-2210", "PAY-2210"],
  ["Fix 500 error (PAY-2210)", "PAY-2210"],
  ["Use SHA-256 for PAY-2210", "PAY-2210"],
  ["Fix CVE-2024-1234 for PAY-2210", "PAY-2210"],
  ["Feature/pay 2210 SHA-256", "PAY-2210"],
  ["WEB-381 cleanup for feat(PAY-2210)", "PAY-2210"],
  ["PAY-2211 and [PAY-2210]", "PAY-2210"],
  ["(pay 2210) WEB-381", "WEB-381"],
  ["pay_2210 and WEB-381", "PAY-2210"],
];

for (const [name, copy] of [
  ["script", script],
  ["demo", demo],
]) {
  test(`findTicket in the ${name}`, () => {
    for (const [title, key] of CASES)
      assert.equal(copy.findTicket(title)?.key ?? null, key, title);
  });
}

test("the demo finds the same key as the script for every demo title", () => {
  const html = readFileSync(join(root, "docs/demo.html"), "utf8");
  const titles = [...html.matchAll(/(?:title: |tr\()'([^']+)'/g)].map(
    (m) => m[1],
  );
  assert.ok(titles.length > 40);
  for (const title of titles)
    assert.equal(
      demo.findTicket(title)?.key,
      script.findTicket(title)?.key,
      title,
    );
});

test("ticketSearchUrl searches both spellings in each owner", () => {
  const url = new URL(ticketSearchUrl("PAY-2210", new Set(["acme", "globex"])));
  assert.equal(url.origin + url.pathname, "https://github.com/pulls");
  assert.equal(
    url.searchParams.get("q"),
    'is:pr ("PAY-2210" OR "PAY_2210") in:title,body org:acme org:globex sort:updated-desc',
  );
});
