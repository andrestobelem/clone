# Use revisions and atomic batches for agent work

Clone identifies each workspace with a persistent Workspace ID, protects mutable records with numeric Record revisions, and executes a Batch as one database transaction and one snapshot publication. Numeric revisions give every interface the same explicit stale-write check. Atomic batches remove repeated process and snapshot costs without adding a second mutation contract. Clone 0.4 requires each CLI mutation to select an actor by input or environment. Read commands can run without an actor.

## Consequences

Snapshot format 3 stores the Workspace ID, Record revisions, and Work evidence. Existing format-1 and format-2 snapshots remain valid import sources. List responses become paginated in 0.3 because no external consumer requires the 0.2 array contract.

## Constitutional test

1. **Pass:** records remain in the user's selected local storage.
2. **Pass:** every operation works without an account or external service.
3. **Pass:** CLI, browser, and HTTP use the same actions and revisions.
4. **Pass:** every mutation resolves and records one actor.
5. **Pass:** revisions reject stale writes and Batch rollback is atomic.
6. **Pass:** snapshot format 3 remains explicit, validated, and portable.
7. **Pass:** the changes improve local work by people and agents.
8. **Pass:** the design uses Workspace ID, Record revision, Batch, and Work evidence consistently.
