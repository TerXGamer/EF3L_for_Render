import test from "node:test";
import assert from "node:assert/strict";
import {
  accountDataSection,
  compactAccountData,
  formatBytes,
  hydrateAccountData,
  normalizeUsername,
  pagination,
  summarizeData,
} from "../core.mjs";

test("pagination is bounded", () => {
  assert.deepEqual(pagination("999", "-4"), { limit: 100, offset: 0 });
  assert.deepEqual(pagination("25", "50"), { limit: 25, offset: 50 });
});

test("account summaries include task and record totals", () => {
  const summary = summarizeData({
    tasks: [{ id: "one" }],
    instances: {
      a: { status: "completed" },
      b: { status: "deleted" },
    },
  });
  assert.equal(summary.taskSettingsCount, 1);
  assert.equal(summary.taskRecordsCount, 2);
  assert.equal(summary.completedCount, 1);
  assert.equal(summary.deletedCount, 1);
});

test("large account sections stay paged out of raw views", () => {
  const section = accountDataSection({ tasks: [1], instances: { a: 1 }, settings: { theme: "dark" } });
  assert.deepEqual(section, { settings: { theme: "dark" } });
});

test("usernames and byte labels are normalized", () => {
  assert.equal(normalizeUsername("  TARIQ  "), "tariq");
  assert.equal(formatBytes(1024), "1.00 KB");
});

test("compact records restore inherited task fields", () => {
  const source = {
    tasks: [{ id: "a", title: "مهمة", description: "", time: "08:00", endTime: "09:00", requiredOverdue: false, importance: 6 }],
    instances: { one: { id: "one", taskId: "a", title: "مهمة", description: "", time: "08:00", endTime: "09:00", requiredOverdue: false, importance: 6, date: "2026-07-31" } },
  };
  const compact = compactAccountData(source);
  assert.equal(compact.instances.one.title, undefined);
  assert.equal(hydrateAccountData(compact).instances.one.title, "مهمة");
});
