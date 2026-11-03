# Values

## User ownership

The user controls the workspace and its records. Clone makes storage locations clear and does not require a hosted account.

**Evidence:** A user can locate, inspect, copy, and remove workspace records without permission from a hosted service.

## Local by default

Core work runs on the user's computer. Network services can support distribution, but they are not required to use the product.

**Evidence:** The primary workflow works without an account or application service outside the user's computer.

## One product contract

The browser, CLI, scheduler, and agent workflows use the same actions and rules. An operation must have the same meaning in every interface.

**Evidence:** Shared operations use the same domain action and have parity tests where more than one interface exposes them.

## Clear identity

People and agents act through explicit identities. History shows who performed each action. Identity records attribution; it does not imply authentication.

**Evidence:** Each mutation stores an actor, and product text keeps attribution separate from authentication.

## Verified change

Writes are validated, recorded, and checked. Recovery protects a committed change from accidental repetition or loss.

**Evidence:** Tests cover input validation, the saved result, and recovery after an interrupted write or publication.
Record revisions prevent a stale caller from overwriting a newer change. Work evidence keeps the checked result attributable to its actor.

## Portable records

Workspace records must be inspectable and movable. Complete snapshots provide a stable form for review, backup, and version control.

**Evidence:** A complete snapshot can be validated, reviewed, exported, and restored without hidden application state.

## Deliberate scope

Clone includes features that strengthen local project work. It avoids features that require Clone to become a hosted collaboration platform.

**Evidence:** Each new feature has a direct use in local issue or project work for a person or an agent.

## Plain communication

Product text and documentation use clear words, short sentences, and stable terms. The same concept keeps the same name.

**Evidence:** Changed text follows `GLOSSARY.md` and uses one term for each product concept.

