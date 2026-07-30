import test from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  calculateStats,
  daysBetween,
  isTaskDueOn,
  latestDueDateOnOrBefore,
  mapTimeIntoWindow,
  wouldCreateDependencyCycle,
} from "../core.mjs";

test("date arithmetic is stable across daylight-saving boundaries", () => {
  assert.equal(daysBetween("2026-03-07", "2026-03-09"), 2);
  assert.equal(addDays("2026-03-08", 1), "2026-03-09");
});

test("monthly recurrence keeps the original day and clamps short months", () => {
  const task = { startDate: "2026-01-31", recurrence: "monthly" };
  assert.equal(isTaskDueOn(task, "2026-02-28"), true);
  assert.equal(isTaskDueOn(task, "2026-03-31"), true);
  assert.equal(isTaskDueOn(task, "2026-03-30"), false);
  assert.equal(latestDueDateOnOrBefore(task, "2026-03-15"), "2026-02-28");
});

test("weekly and custom recurrence return the latest expected occurrence", () => {
  assert.equal(
    latestDueDateOnOrBefore({ startDate: "2026-07-01", recurrence: "weekly" }, "2026-07-17"),
    "2026-07-15",
  );
  assert.equal(
    latestDueDateOnOrBefore(
      { startDate: "2026-07-01", recurrence: "custom", intervalDays: 3 },
      "2026-07-10",
    ),
    "2026-07-10",
  );
});

test("display-window mapping preserves both endpoints", () => {
  const window = { enabled: true, start: "08:00", end: "18:00" };
  assert.equal(mapTimeIntoWindow("00:00", window), "08:00");
  assert.equal(mapTimeIntoWindow("23:59", window), "18:00");
});

test("pending tasks are not counted as missed", () => {
  const stats = calculateStats([
    { status: "completed" },
    { status: "main" },
    { status: "requiredOverdue" },
    { status: "deleted" },
  ]);
  assert.deepEqual(
    { total: stats.total, completed: stats.completed, pending: stats.pending, missed: stats.missed, rate: stats.rate },
    { total: 3, completed: 1, pending: 1, missed: 1, rate: 50 },
  );
});

test("dependency validation blocks direct and indirect cycles", () => {
  const tasks = [
    { id: "a", dependencyId: "" },
    { id: "b", dependencyId: "a" },
    { id: "c", dependencyId: "b" },
  ];
  assert.equal(wouldCreateDependencyCycle(tasks, "a", "c"), true);
  assert.equal(wouldCreateDependencyCycle(tasks, "c", "a"), false);
});
