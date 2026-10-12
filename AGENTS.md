# General Requirements

All of the following content must be strictly adhered to.

Development is divided into two phases by default:

1. Solution Design
2. Code Implementation

The solution design must be confirmed by the user before proceeding to code implementation. Exceptions apply when the user explicitly requests direct implementation, does not require confirmation, or asks to skip the solution design phase.

The following principles must be followed throughout the development process:

1. **Introduce and retain compatibility code with caution.**
   Compatibility increases implementation and maintenance complexity. Before adding or retaining compatibility logic such as compatibility layers, fallbacks, dual-track implementations, or migrations, first confirm its necessity and the target of compatibility. Without a clear compatibility requirement, focus on current needs, remove obsolete code paths, old implementations, and outdated abstractions, and do not retain extra complexity for hypothetical historical scenarios.

2. **Choose the simplest implementation that fully meets current requirements.**
   Avoid speculative abstractions, unnecessary configuration, superfluous indirection layers, and complex structures built for assumed future needs. Simplicity does not mean a makeshift solution; the chosen approach should be clear, reliable, and maintainable in the long term.

3. **Start with the smallest workable end-to-end implementation, then add capabilities incrementally.**
   Make the full chain work first, then refine, abstract, and optimize based on real needs. Do not exchange an incomplete complex architecture for a system that cannot actually run and be validated.

4. **Maintain modularity and clear boundaries of responsibility.**
   Modules should have clear responsibilities, well-defined boundaries, and simple dependencies. Avoid both piling up logic and introducing meaningless layering, wrapping, or abstraction. The goal of modularity is to reduce complexity.

5. **Prefer mature capabilities over self-implementation.**
   When mature, well-maintained libraries, frameworks, SDKs, or platform capabilities can reduce complexity or improve reliability, they should be prioritized. Do not reimplement common functionality without a clear reason.

6. **First investigate existing project capabilities before adding new implementations or dependencies.**
   Priority order: existing project code and infrastructure → existing dependencies → capabilities of existing dependencies not yet used → new mature dependencies → self-implementation. Before concluding that an existing library lacks a capability, first check its official documentation, API, and type definitions.

7. **Architectural decisions should be reasonable for the long term, but do not implement future requirements in advance.**
   Do not adopt workarounds that will clearly require a full replacement later. Current choices should be maintainable over time, but do not prebuild complex architectures, generic frameworks, extension points, or configuration systems for requirements that have not yet emerged.

8. **Research mature solutions before designing.**
   First understand how the current project, the frameworks used, mature products, and excellent open-source projects address similar problems. Prioritize battle-tested patterns and conventions, while adapting them to the actual context of the current project rather than mechanically copying them.

# Solution Design

Analyze requirements, determine the solution, and define the implementation plan for this solution within the current project.

**Before formulating the solution, you must first confirm whether there are unclear matters that would affect the solution. For issues such as ambiguous objectives, business rules, scope boundaries, technical constraints, compatibility requirements, critical behavior, or implementation direction—where there is ambiguity, insufficient information, or multiple reasonable interpretations—you must first ask the user for clarification and wait for confirmation. Do not make assumptions, fill in requirements, or choose one interpretation to continue developing the solution. Only local implementation details that do not affect solution decisions may be decided based on the current project context.**

The solution design must be based on an understanding of the actual code and existing capabilities of the current project. Always inspect the relevant code, dependencies, infrastructure, and existing implementations before determining the solution. Do not design in isolation from the project's current state.

The level of detail in the solution design should match the complexity of the task:

- For simple, localized changes, both the solution and implementation plan can be concise, covering only key decisions, modification locations, and implementation approach.
- For tasks involving multiple modules, state transitions, interface changes, architectural adjustments, or important technical decisions, provide a full explanation of the solution, code organization, data flow, invocation relationships, and key boundaries.
- Do not mechanically expand content that has no actual decision-making value just for the sake of formality.

The solution design consists of two parts: Solution and Implementation Plan. They should be submitted as a complete solution design for user confirmation. After confirmation, proceed to code implementation.

During implementation, if it is discovered that a critical premise of the confirmed solution is invalid, new significant ambiguities in the requirements arise, or continuing implementation would require introducing important technical decisions that would materially alter the solution or implementation plan, you should stop the relevant implementation, explain the situation to the user, and re-confirm the solution design.

For ordinary local implementation details, and for adjustments that do not change the confirmed requirements objectives, scope boundaries, overall solution, or core implementation structure, you may proceed based on the actual project context without further confirmation.

## Solution

From the perspective of requirements and system behavior, define the overall approach to solving the problem, focusing on "what approach to take and why."

This part primarily accomplishes:

- Clarify requirements, objectives, scope boundaries, and what is out of scope.
- Clarify core business processes and expected behavior.
- Determine the overall solution approach and key technical decisions.
- Clarify capabilities to be reused, adjusted, added, or removed.
- Clarify important data, state, and interaction relationships.
- Identify important constraints, risks, and trade-offs.
- For important decisions where multiple reasonable solutions exist, explain the rationale for the chosen option.

The solution should first describe stable business concepts, system behavior, and technical ideas, avoiding premature details of specific files, classes, functions, and code organization.

## Implementation Plan

Based on the above solution and the current project structure, translate the solution into a concrete code modification plan, focusing on "where to change, how to organize, and how to connect."

This part primarily accomplishes:

- Determine modules and files to be added, modified, or deleted.
- Clarify the responsibilities of each module or key code unit.
- Clarify dependencies and primary invocation relationships between modules.
- Clarify key data structures, state, and data flow.
- Clarify key interfaces, core processes, and exception boundaries.
- Clarify existing code, components, infrastructure, and dependencies to be reused.
- Clarify obsolete implementations and old code paths to be removed or replaced.
- Clarify necessary compatibility handling and its scope.
- For important modification points, specify the concrete implementation approach.

The implementation plan should be specific enough to guide subsequent code implementation, but should not pre-design low-level details that can be naturally determined during coding based on local context, such as local variables, routine helper function splits, or code organization adjustments that do not affect the overall design.

# Code Implementation

Complete the code modifications according to the confirmed solution design.

This phase primarily accomplishes:

- Add, modify, or delete code according to the confirmed solution and implementation plan.
- Integrate and reuse existing capabilities.
- Remove obsolete code paths replaced by the new implementation, along with related code, configuration, and abstractions that are no longer effective.
- Complete necessary exception handling, type definitions, and comments.
- Confirm that the implementation aligns with the confirmed solution design and does not expand the scope of changes.
- After implementation is complete, conduct a thorough self-review of the changes and directly correct issues found during the review. After the review, clearly provide a concise final conclusion.

## Code Implementation Quality Requirements

- **Most important: Always organize code around the primary business process, ensuring the main flow is concise, intuitive, continuous, and easy to understand.** Within the constraints of meeting requirements and necessary constraints, use as little code as possible, keeping it simple and with clearly defined responsibilities. Do not let abstraction, layering, exception handling, defensive logic, compatibility logic, or special branches dominate. Avoid over-defense and hard-coding without real business basis. The code structure should first and foremost make the main business process easy to read and understand.
- Prefer modern, idiomatic, type-safe, and maintainable coding practices consistent with the current technology stack.
- Keep core logic clear, structure simple, and naming accurate. Avoid duplication, redundancy, and code without practical value.
- Prefer designing clean data structures so that control flow remains naturally simple.
- Exception handling should follow "handle at boundaries, refine as needed." Only handle exception scenarios that genuinely need to be addressed. Avoid repeated catching, excessive layering of defenses, and prematurely enumerating all possible failure cases.
- Only add necessary comments that explain key business rules, design rationale, and special constraints.
- Do not arbitrarily modify unrelated code; code directly relevant to the current task that is unreasonable may be refactored or removed. Suggestions for improvements outside the scope should be made only as recommendations.
- Do not introduce abstractions and splits solely for modularity, potential reuse, testability, shorter functions, or superficial "code cleanliness." Functions, methods, classes, intermediate layers, or helpers should only be introduced if they can clearly express business concepts, form clear responsibility boundaries, reduce complexity, or provide actual reuse value.
- Avoid helpers that have no independent semantics, are called only once, and merely forward parameters, perform simple wrapping, or trivial transformations. Avoid mechanically splitting a continuous and easily understood process into many small functions, which forces frequent jumping during reading.
- Local variables should express meaningful intermediate concepts. Prefer using expressions directly for variables used only once without adding semantic value.
- Naming should clearly convey specific business meaning or behavior. Avoid generic names like `process`, `handle`, `data`, `result`, `value`, `helper`, `utils`, which lack concrete semantics.
- Every added layer of function calls, wrapping, or abstraction should clearly reduce complexity, define boundaries, express business concepts, or provide actual reuse; otherwise, prefer direct implementation. Do not aim for shorter functions, more functions, or more layers as quality goals. Prioritize reducing the number of concepts, code jumps, and indirection layers needed to understand the complete flow.
- After completing functionality, re-examine the newly added or modified code. Actively inline valueless helpers, remove redundant variables, wrapper layers, over-defense, and unnecessary hard-coding. Simplify invocation relationships. If removing an abstraction makes the code easier to understand, remove that abstraction.
- During self-review, start from the full set of changes rather than individual files or local code snippets. Focus on: whether requirements are fully implemented, whether the implementation aligns with the confirmed solution design, whether the main flow is clear, whether module responsibilities and invocation relationships are reasonable, whether boundary and exception handling are necessary and correct, whether existing business chains are broken or behaviors unrelated to the current requirements have been altered, and whether there are missing modifications, leftover old code, duplicate implementations, unnecessary compatibility logic, or over-design, as well as whether any changes lacking clear value have been introduced.
- Issues found during review should be corrected directly. After corrections, re-inspect the related changes until no further issues clearly requiring correction remain.

# Project-Specific Requirements



## Git Workflow

- Never develop directly on `main`.
- For each task, create a dedicated branch from `main`.
- Use branch prefixes such as:
  - `feat/`
  - `fix/`
  - `refactor/`
  - `chore/`
  - `docs/`
- Keep each branch focused on one task.
- Commit all completed work to the task branch.
- Automatically commit the code when each work done.
- Run relevant tests before finishing.
- **Never merge the PR or merge the branch into `main`.**
- **Never push directly to `main`.**
- The human user is always responsible for reviewing and merging the PR.
- If a PR cannot be created, leave the work committed on the branch and report the branch name and suggested PR title/description.

Default flow:

```text
main → task branch → develop → test → commit → PR → STOP
```

## Before you start: read `docs/agents-landing.md`

This repository may have more than one agent working in it at the same time. Read
[`docs/agents-landing.md`](docs/agents-landing.md) first: it holds the project map,
the DSH seams, how to run and verify (including the gateway's own test suite), the
production operating rules and who may write where, the current state snapshot, and
the known issues. It also lists the file surfaces each workstream owns, so you do not
edit a file another agent is holding.

## Money changes: documentation first

Anything that touches money — how a request is priced, what a user is charged, how
credit is granted or spent, what the ledger holds, what the reports print — **starts
with a design document, and that document is committed and reviewed before any
implementation code is written**. This applies to every money change, without
exception.

**Where the documents live.** Nothing about money is documented anywhere else:

- `docs/money/standard.md` — the standing rules and the single source of truth:
  units, the settlement rate, the deduction order, the credit-source list, the ledger
  field semantics, and the definition of every number the reports print.
- `docs/money/designs/<YYYY-MM-DD>-<slug>.md` — one document per money change, dated
  by the day it was written.

**Changing a rule.** Edit `docs/money/standard.md` first, add a dated row to its
change log, and only then change the code that depends on it. A shipped rate, rounding
rule, deduction order, or source list is never changed silently.

**What every money design document must contain.** Keep it to the change at hand; the
standing rules are referenced, not restated:

1. A header: date, status (`draft` / `confirmed, to implement` / `shipped` /
   `abandoned`), the documents it depends on, and what it affects.
2. Goal, scope, and — explicitly — what is out of scope.
3. The settlement arithmetic and the boundary cases that must be tested, as worked
   examples (for instance: a request that spans both balances, the allowed overdraft,
   rounding).
4. Data model: tables and columns added, changed, or dropped; the migration; and what
   happens to historical rows.
5. The flows: the check before a model call, the settlement after it, granting credit,
   and any daily reset — each precise enough to write a test from.
6. Interfaces and configuration: response fields and how older clients keep working,
   operator entry points, settings and their defaults.
7. Client impact: what users will see, and whether a release is required.
8. Reporting: which numbers are produced and how each is defined.
9. Rollout: the order of steps, and how the change is observed before it is enforced.
10. Verification: unit, integration, and the check that runs against real data.
11. Risks and trade-offs, stated plainly.
12. A change log, so the history of a rule is visible rather than inferred.

**A money change is not finished until the document matches what shipped**: update the
status and the change log in the same branch that changes the behaviour.

