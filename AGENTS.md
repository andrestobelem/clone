# Repository instructions

## Product direction

- **Routine change:** Follow the current specification and established architecture. Product-direction documents are not required when behavior and boundaries stay unchanged.
- **Behavior change:** Read [SPEC.md](SPEC.md) and [GLOSSARY.md](GLOSSARY.md). Update them in the same change when behavior or domain meaning changes.
- **Product choice:** Read [MISSION.md](MISSION.md), [VISION.md](VISION.md), and [VALUES.md](VALUES.md) when a task selects product scope, direction, or priority.
- **Constitutional change:** Read [CONSTITUTION.md](CONSTITUTION.md) and run its decision test before implementation when a task affects product scope, architecture, storage, identity, synchronization, security boundaries, destructive operations, or a shared interface contract.
- **Conflict:** State the conflicting constitutional rule before implementation. Offer a compliant design or an explicit constitutional amendment.

## Commits

- Use Conventional Commits: `type(scope): description`. The scope is optional.
- Make atomic commits. Each commit must contain one complete, coherent change.
- Never add a `Co-authored-by` trailer or other co-author attribution to a commit message.

## Writing

- Follow ASD-STE100 Simplified Technical English for English text in documentation, comments, commit messages, and user-facing content.
- Use clear words, short sentences, and direct instructions. Use the same term for the same concept.
- Never use AI slop: filler, empty praise, vague claims, stock phrases, or needlessly complex words.
- State concrete facts and actions. Remove text that adds no useful information.

## Skills

- **Domain modeling:** Read [.agents/skills/domain-modeling/SKILL.md](.agents/skills/domain-modeling/SKILL.md) when a task defines or changes domain terms, `GLOSSARY.md`, or an ADR. Reading the glossary for established terms does not require this skill.
- **Writing for agents:** Read [.agents/skills/writing-for-agents/SKILL.md](.agents/skills/writing-for-agents/SKILL.md) when a task creates or changes a skill, `AGENTS.md`, `CLAUDE.md`, or a document reached through an agent context pointer.
- **Design principles:** Read [.agents/skills/design-principles/SKILL.md](.agents/skills/design-principles/SKILL.md) when a task creates, refactors, or reviews component boundaries, responsibilities, interfaces, dependencies, or state access.
- Use every skill that matches the task. Keep each skill's instructions within the task's authorized scope.

## Domain language

- Read the root `GLOSSARY.md` before you change domain terms. Use its preferred terms and avoid terms listed under `_Avoid_`.
- When a domain term or boundary is resolved, update `GLOSSARY.md` in the same change. Add only concepts that are specific to this product.
- Keep `GLOSSARY.md` focused on domain meaning. Do not add implementation details, requirements, or open questions.

## Workspace operations

- Treat the command catalog as the operation contract. Use [docs/AGENTS.md](docs/AGENTS.md) for identity, revisions, pagination, Batch, evidence, and recovery. Read it before operating a workspace.

- For any workspace record read or write, follow [.agents/skills/workspace-operations/SKILL.md](.agents/skills/workspace-operations/SKILL.md). It defines the CLI, actor identity, verification, and recovery procedure.
