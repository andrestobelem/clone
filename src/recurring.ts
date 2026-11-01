import { rows, run, sql, type Database } from "./database.js";
import type { StoragePaths } from "./types.js";
import { dispatchMutation } from "./workspace-mutations.js";

export function runDueRecurring(
  database: Database,
  paths: StoragePaths,
): number {
  const today = new Date().toISOString().slice(0, 10);
  let created = 0;
  for (const rule of rows(
    database,
    "SELECT * FROM recurring_rules WHERE enabled=1 ORDER BY id",
  )) {
    let due = String(rule.next_run).slice(0, 10);
    if (due > today) continue;
    dispatchMutation(
      database,
      "POST",
      "/api/issues",
      {
        actorId: 1,
        teamId: Number(rule.team_id),
        title: String(rule.title),
        description: String(rule.description),
        recurringRule: {
          ruleId: Number(rule.id),
          cadence: String(rule.cadence),
        },
      },
      paths,
    );
    do due = recurringNext(due, String(rule.cadence));
    while (due <= today);
    run(
      database,
      "UPDATE recurring_rules SET next_run=? WHERE id=?",
      due,
      sql(rule.id),
    );
    created += 1;
  }
  return created;
}

function recurringNext(value: string, cadence: string): string {
  const [year, month, day] = value.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (cadence === "Daily") date.setUTCDate(date.getUTCDate() + 1);
  else if (cadence === "Every 2 weeks") date.setUTCDate(date.getUTCDate() + 14);
  else if (cadence === "Monthly") {
    const targetMonth = month === 12 ? 1 : month + 1;
    const targetYear = month === 12 ? year + 1 : year;
    const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
    date.setTime(Date.UTC(targetYear, targetMonth - 1, Math.min(day, lastDay)));
  } else date.setUTCDate(date.getUTCDate() + 7);
  return date.toISOString().slice(0, 10);
}
