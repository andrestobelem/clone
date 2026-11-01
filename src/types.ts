export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type Row = Record<string, string | number | null>;

export interface StoragePaths {
  readonly database: string;
  readonly dataDirectory: string;
  readonly snapshotDirectory: string;
  readonly attachmentsDirectory: string;
  readonly backupsDirectory: string;
}
