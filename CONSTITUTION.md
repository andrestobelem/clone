# Constitution

This constitution defines the rules that guide product and engineering decisions in Clone. [MISSION.md](MISSION.md) states the current purpose. [VISION.md](VISION.md) states the intended future. [VALUES.md](VALUES.md) defines the standards used to pursue both.

## 1. The user owns the workspace

Workspace records belong under the user's control. Clone must state where it stores the database, snapshots, attachments, and backups. A user must be able to keep, copy, inspect, or remove those records without permission from a hosted service.

## 2. Core work remains local

Creating, reading, changing, and recovering workspace records must work without a hosted account or an external service. The default server must bind to loopback. A feature that exposes the server beyond the local computer requires authentication and a separate security design before implementation.

## 3. Every interface follows one contract

The browser, CLI, scheduler, and agent workflows must use the same domain actions, validation rules, and storage contract. An interface must not create a second meaning for an existing operation. Tests must cover parity where more than one interface exposes the same action.

## 4. People and agents are accountable actors

Every mutation records an actor identity. Agents use persistent keys and explicit actor IDs. Human and agent identities can take part in work, but a member remains a human profile. Attribution must not be described as authentication.

## 5. Changes are safe and recoverable

Clone validates input before a write. A committed write must survive an interrupted snapshot publication. Recovery must finish or report the existing change without repeating it. Destructive replacement operations require validation, a preview when available, and a backup of existing records.

## 6. Records remain portable

SQLite is the local working store. Complete snapshots are the portable record form. Snapshot formats must be stable, explicit, and validated. Import replaces a complete workspace state; it must not be presented as a merge.

## 7. Scope serves the local product

New features must improve local issue and project work for a person or their agents. Hosted collaboration, sign-in, invitations, external notifications, and third-party integrations are outside the core product unless the constitution changes first. Inspiration from another product does not justify copying its scope.

## 8. Language remains precise

Product language must follow [GLOSSARY.md](GLOSSARY.md). Documentation and user-facing text must use clear words, short sentences, and one term for one concept. A domain boundary change requires a matching glossary change.

## Decision test

Run this test before implementation when a change affects product scope, architecture, storage, identity, synchronization, security boundaries, destructive operations, or a contract shared by more than one interface. Routine changes that preserve established behavior do not require a recorded test.

For each question, record `Pass`, `Not applicable`, or `Conflict`, followed by one concrete reason:

1. Does the change keep workspace records under user control?
2. Can core work still run without a hosted account or external service?
3. Does every affected interface keep the same product contract?
4. Is the actor and resulting history clear?
5. Can Clone validate, verify, and recover the change?
6. Do records remain inspectable and portable?
7. Does the change serve the defined local product scope?
8. Does it use the terms in the glossary?

A test is complete when every question has a status and evidence. Explain every `Not applicable` result. Resolve a `Conflict` by changing the proposal or amending this constitution before implementation.

## Governance

- This constitution overrides conflicting product guidance in other repository documents.
- Code, tests, documentation, and release behavior must agree with it.
- A constitutional change must update this file and every affected mission, vision, value, glossary, specification, or architecture document in the same coherent change.
- A pull request or commit that changes a constitutional rule must state the rule and the reason for the change.
- Small wording corrections that do not change meaning do not require a governance note.

