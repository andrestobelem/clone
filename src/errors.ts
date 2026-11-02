export class CloneError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly exitCode: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CloneError";
  }
}

export class InvalidInputError extends CloneError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, "invalid_input", 2, details);
    this.name = "InvalidInputError";
  }
}

export class SyncConflictError extends CloneError {
  constructor(message: string) {
    super(message, "sync_conflict", 3);
    this.name = "SyncConflictError";
  }
}

export class RelationshipConflictError extends CloneError {
  constructor(message: string) {
    super(message, "relationship_conflict", 3);
    this.name = "RelationshipConflictError";
  }
}

export class RecordConflictError extends CloneError {
  constructor(expectedRevision: number, currentRevision: number) {
    super("The record changed after it was read", "record_conflict", 3, {
      expectedRevision,
      currentRevision,
      recovery: "read_then_retry",
    });
    this.name = "RecordConflictError";
  }
}

export class StorageError extends CloneError {
  constructor(message: string) {
    super(message, "storage_error", 4);
    this.name = "StorageError";
  }
}

export class PendingExportError extends CloneError {
  constructor(message: string) {
    super(message, "pending_export", 4, {
      committed: true,
      recoveryRequired: true,
    });
    this.name = "PendingExportError";
  }
}
