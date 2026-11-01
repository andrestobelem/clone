import fs from "node:fs";
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";

import { InvalidInputError } from "./errors.js";
import type { Row, StoragePaths } from "./types.js";

export type Database = DatabaseSync;

export function openDatabase(
  paths: StoragePaths,
  options: { readonly create?: boolean; readonly allowLegacy?: boolean } = {},
): Database {
  if (!options.create && !fs.existsSync(paths.database)) {
    throw new InvalidInputError(
      "Database not found. Run init or sync import first.",
    );
  }
  if (options.create) {
    fs.mkdirSync(paths.dataDirectory, { recursive: true });
  }

  const database = new DatabaseSync(paths.database, {
    open: true,
    readOnly: false,
    enableForeignKeyConstraints: true,
    timeout: 15_000,
  });
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = WAL");

  if (
    !options.create &&
    !options.allowLegacy &&
    !hasTable(database, "actors")
  ) {
    database.close();
    throw new InvalidInputError(
      "Database needs migration. Run clone sync migrate.",
    );
  }
  return database;
}

export function hasTable(database: Database, name: string): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(name),
  );
}

function all(statement: StatementSync, ...values: SQLInputValue[]): Row[] {
  return statement.all(...values) as Row[];
}

function get(
  statement: StatementSync,
  ...values: SQLInputValue[]
): Row | undefined {
  return statement.get(...values) as Row | undefined;
}

export function lastInsertId(database: Database): number {
  const row = database.prepare("SELECT last_insert_rowid() AS id").get() as {
    id: number;
  };
  return Number(row.id);
}

export function rows(
  database: Database,
  query: string,
  ...values: SQLInputValue[]
): Row[] {
  return all(database.prepare(query), ...values);
}

export function one(
  database: Database,
  query: string,
  ...values: SQLInputValue[]
): Row | undefined {
  return get(database.prepare(query), ...values);
}

export function scalar(
  database: Database,
  query: string,
  ...values: SQLInputValue[]
): SQLInputValue | undefined {
  const row = one(database, query, ...values);
  return row ? (Object.values(row)[0] as SQLInputValue) : undefined;
}

export function run(
  database: Database,
  query: string,
  ...values: SQLInputValue[]
) {
  return database.prepare(query).run(...values);
}

export function sql(value: unknown): SQLInputValue {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value as SQLInputValue;
}
