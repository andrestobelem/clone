# Repository instructions

## Commits

- Use Conventional Commits: `type(scope): description`. The scope is optional.
- Make atomic commits. Each commit must contain one complete, coherent change.
- Never add a `Co-authored-by` trailer or other co-author attribution to a commit message.

## Writing

- Follow ASD-STE100 Simplified Technical English for English text in documentation, comments, commit messages, and user-facing content.
- Use clear words, short sentences, and direct instructions. Use the same term for the same concept.
- Never use AI slop: filler, empty praise, vague claims, stock phrases, or needlessly complex words.
- State concrete facts and actions. Remove text that adds no useful information.

## Domain language

- Read the root `GLOSSARY.md` before you change domain terms. Use its preferred terms and avoid terms listed under `_Avoid_`.
- When a domain term or boundary is resolved, update `GLOSSARY.md` in the same change. Add only concepts that are specific to this product.
- Keep `GLOSSARY.md` focused on domain meaning. Do not add implementation details, requirements, or open questions.
- Use `.agents/skills/domain-modeling/SKILL.md` and its `GLOSSARY-FORMAT.md` when you need to build or change the domain model or glossary.

## Workspace operations

- Use [.agents/skills/workspace-operations/SKILL.md](.agents/skills/workspace-operations/SKILL.md) for requests to read or change workspace data.
- Read [Agent CLI guide](docs/AGENTS.md) before you use the workspace.
- Use the CLI for workspace actions. Do not edit SQLite or snapshot records to perform normal actions.
- Use a registered actor ID for agent writes.
