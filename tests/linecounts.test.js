const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const source = readFileSync(
  join(__dirname, "..", "github-pr-list-status.user.js"),
  "utf8",
);
const from = source.indexOf("  const CONFIG = {");
const to = source.indexOf("  // Undocumented endpoints", from);
assert.ok(from >= 0 && to > from, "CONFIG markers not found");
const { lockfilePattern, generatedPattern, testPattern, docsPattern } =
  new Function(`${source.slice(from, to)}; return CONFIG;`)();

const TESTS = [
  "src/components/__tests__/Button.tsx",
  "src/api/__mocks__/client.ts",
  "src/__snapshots__/App.test.tsx.snap",
  "src/utils/format.test.ts",
  "src/utils/format.spec.js",
  "apps/web/e2e/login.e2e-spec.ts",
  "cypress/support/commands.ts",
  "src/components/Card.cy.tsx",
  "e2e/checkout.ts",
  "test/helpers.js",
  "tests/integration/orders.py",
  "src/test/java/com/example/OrderServiceTest.java",
  "app/src/androidTest/java/com/example/MainActivityTest.kt",
  "src/testFixtures/kotlin/Builders.kt",
  "spec/models/user_spec.rb",
  "lib/parser_test.exs",
  "internal/store/store_test.go",
  "internal/store/testdata/rows.json",
  "fixtures/orders.json",
  "src/mocks/handlers.ts",
  "pkg/test_parser.py",
  "conftest.py",
  "orders/tests.py",
  "Tests/AppTests/LoginTests.swift",
  "MyApp.Tests/OrderTests.cs",
  "src/OrderSpec.groovy",
];

const NOT_TESTS = [
  "src/latest.ts",
  "src/contest.ts",
  "pkg/attestation.go",
  "vitest.config.ts",
  "jest.config.js",
  "specs/design.md",
  "src/testimonials/Quote.tsx",
  "src/experiments/ab-test.service.ts",
  "scripts/speed-test.ts",
  "src/Contest.java",
  "src/contests.py",
  "README.md",
  "api/openapi_spec.yaml",
  "config/latest_spec.json",
];

test("testPattern matches test paths", () => {
  for (const path of TESTS) assert.ok(testPattern.test(path), path);
});

test("testPattern leaves other paths alone", () => {
  for (const path of NOT_TESTS) assert.ok(!testPattern.test(path), path);
});

const GENERATED = [
  "api/orders/v1/orders.pb.go",
  "api/orders/v1/orders_grpc.pb.go",
  "src/proto/orders_pb.js",
  "src/proto/orders_pb.d.ts",
  "src/proto/orders_grpc_pb.js",
  "src/gen/orders_pb.ts",
  "src/graphql/types.generated.ts",
  "orders/v1/orders_pb2.py",
  "orders/v1/orders_pb2_grpc.py",
  "orders/v1/orders_pb2.pyi",
  "Sources/Orders/orders.pb.swift",
  "src/generated/graphql.ts",
  "src/__generated__/schema.ts",
  "dist/index.js",
  "public/js/vendor.min.js",
  "public/css/site.min.css",
  "public/js/app.js.map",
  "api/v1/zz_generated.deepcopy.go",
  "lib/models/order.g.dart",
  "lib/models/order.freezed.dart",
  "Forms/MainForm.Designer.cs",
];

const NOT_GENERATED = [
  "src/generator.ts",
  "src/regenerate.go",
  "src/distance.ts",
  "build/deploy.sh",
  "src/minify.js",
  "src/map.ts",
  "src/sitemap.xml",
  "src/pb/client.go",
];

const DOCS = [
  "README.md",
  "AGENTS.md",
  ".github/copilot-instructions.md",
  "docs/guide.mdx",
  "CHANGELOG.markdown",
  "docs/Setup.MD",
];
const NOT_DOCS = ["src/markdown.ts", "docs/diagram.png", "src/md5.js"];

test("generatedPattern matches generated paths", () => {
  for (const path of GENERATED) assert.ok(generatedPattern.test(path), path);
});

test("generatedPattern leaves other paths alone", () => {
  for (const path of NOT_GENERATED)
    assert.ok(!generatedPattern.test(path), path);
});

test("docsPattern matches Markdown only", () => {
  for (const path of DOCS) assert.ok(docsPattern.test(path), path);
  for (const path of NOT_DOCS) assert.ok(!docsPattern.test(path), path);
});

test("the line patterns have no g flag", () => {
  for (const pattern of [
    lockfilePattern,
    generatedPattern,
    testPattern,
    docsPattern,
  ])
    assert.ok(!pattern.global, pattern);
});

// LINE_FILTERS, groupLines, and shownLines, run against the real patterns with chosen toggles.
const lineFilters = new Function(
  "CONFIG",
  "isOn",
  `${source.slice(
    source.indexOf("  // In match order."),
    source.indexOf("  const HIGHLIGHT_STYLES"),
  )}${source.slice(
    source.indexOf("  // Files are grouped by which patterns"),
    source.indexOf("  // Each endpoint is requested"),
  )}; return { groupLines, shownLines };`,
);

function shown(on, files) {
  const config = {
    lockfilePattern,
    generatedPattern,
    testPattern,
    docsPattern,
  };
  const { groupLines, shownLines } = lineFilters(config, (key) =>
    on.includes(key),
  );
  const diffs = files.map(([path, linesAdded, linesDeleted]) => ({
    path,
    linesAdded,
    linesDeleted,
  }));
  return shownLines(groupLines(diffs));
}

const FILES = [
  ["src/orders.ts", 100, 20],
  ["package-lock.json", 900, 800],
  ["src/orders.test.ts", 60, 5],
  ["tests/fixtures/README.md", 10, 0],
  ["docs/setup.md", 30, 2],
  // file_tree leaves out zero counts.
  ["docs/empty.md"],
];

test("shownLines leaves out each enabled kind once, first match first", () => {
  const all = shown(
    ["excludeLockfiles", "excludeGenerated", "excludeTests", "excludeDocs"],
    FILES,
  );
  assert.deepEqual(all, {
    linesAdded: 100,
    linesDeleted: 20,
    skippedLines: { excludeLockfiles: 1700, excludeTests: 75, excludeDocs: 32 },
  });
});

test("shownLines gives a file to the next enabled kind when its first is off", () => {
  const docsOnly = shown(["excludeDocs"], FILES);
  assert.deepEqual(docsOnly, {
    linesAdded: 1060,
    linesDeleted: 825,
    skippedLines: { excludeDocs: 42 },
  });
});

test("shownLines counts everything with every filter off", () => {
  assert.deepEqual(shown([], FILES), {
    linesAdded: 1100,
    linesDeleted: 827,
    skippedLines: {},
  });
});
