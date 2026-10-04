# Issue and project workspace

This glossary defines the core terms for the local issue and project workspace. It records the concepts used by the current product model.

## Workspace structure

**Workspace**:
A container for teams and members.

**Team**:
A group that owns issues, workflow statuses, and cycles. An issue belongs to one team. A project can link to more than one team.
_Avoid_: Squad

**Member**:
A person in the workspace. Each member has an actor identity.

**Actor**:
A person or agent with an identity in the workspace. An actor can perform actions, receive issues, and take part in work.

**Agent**:
A software actor with a persistent identity in the workspace.

**Team participation**:
The relationship that makes an actor part of a team.
_Avoid_: Team membership (when the relationship can include agents)

**Project participation**:
The relationship that makes an actor part of a project.

## Planning work

**Issue**:
A unit of work owned by one team. It can be assigned to an actor and linked to a project, cycle, or other issue.
_Avoid_: Task, ticket

**Issue identifier**:
A stable reference that identifies one issue in the workspace. An issue keeps this reference when it moves to another team.

**Sub-issue**:
An issue that belongs to a parent issue. Parent and sub-issue relationships form a hierarchy.

**Workflow status**:
A state in a team's issue workflow.
_Avoid_: Project status, state (when referring to an issue status)

**Project**:
A coordinated body of work that organizes issues and milestones. Every linked issue must belong to one of the project's teams.

**Cycle**:
A time-boxed planning period owned by one team.
_Avoid_: Sprint

**Milestone**:
A checkpoint in a project with a status and an optional due date.

## Finding work

**Saved view**:
A saved set of filters and display settings for issues or projects. Its scope can be personal, workspace-wide, or team-wide.
