---
node_type: adr
title: "ADR-001 — Page Interaction API v2"
status: active
updated: 2026-06-11
tags: [adr, api-design, page-interaction, mcp, agent-operability]
links:
  depends_on: [../../overview/product.md, ../../spec/spec.md]
  part_of: [../INDEX.md]
---

# ADR-001 — Page Interaction API v2

## Status

Accepted

## Date

2026-05-12

## Context

BrowserPowers is not trying to be a full Playwright competitor. Its job is different: it is a bridge that lets an external agent control an already-running, real browser through a browser extension and core server.

The current page interaction API mixes several styles:

- many narrow page tools such as `page.click`, `page.fill`, `page.check`
- heuristic one-off helpers such as `page.smart_click`
- unrestricted raw JavaScript via `page.execute`

This has produced an API that works, but has no single interaction model. It is too selector-centric, too fragmented, and too weak in action feedback for agent-driven operation.

For BrowserPowers, the main design target is not human test author ergonomics. The design target is **agent operability**:

- low ambiguity
- explicit success/failure
- safe defaults
- recoverable errors
- structured evidence
- fast follow-up actions
- an escape hatch for rare unsupported cases

Because the project is not public and nobody depends on the current surface yet, the API may be changed directly with breaking changes.

## Decision

BrowserPowers will adopt a new **Page Interaction API v2** with the following principles:

1. **Do not clone Playwright's full API surface.**
2. **Do adopt Playwright-like targeting philosophy where useful**, especially semantic targeting instead of raw CSS-only targeting.
3. **Optimize for agent use, not test-framework parity.**
4. **Reduce the command surface to three top-level page tools:** `page.read`, `page.act`, and `page.js`.
5. **Use an `action` discriminator inside `page.read` and `page.act` instead of creating many more top-level tools.**
6. **Require clear textual and structured feedback for every action.**
7. **Introduce inspection anchors** so agents can inspect once and act quickly on returned mini-ids.
8. **Retain `page.js` as an explicit, gated escape hatch**, not the primary interaction model.

## Design Principles

### 1. Few top-level tools, many actions

The API should avoid exploding into many near-duplicate functions. BrowserPowers should expose a small number of tool families and extend them through explicit action types.

### 2. Agent-readable outcomes

Every page tool must return a result that an agent can understand without reverse-engineering browser internals or relying on exceptions alone.

### 3. Safe ambiguity handling

When an action is ambiguous, the tool should fail safely and explain why, instead of guessing.

### 4. Fast inspect → act workflow

Inspection should return lightweight anchors for interactable elements so follow-up actions can target `a1`, `a2`, etc. instead of repeating long selectors or target objects.

### 5. Escape hatch remains available

Arbitrary JS execution is still valuable, but it must remain rare, explicit, and gated behind `page.js` permissions.

## Chosen API Shape

### Top-level tools

BrowserPowers page interaction is organized into three tool families:

```ts
page.read(...)
page.act(...)
page.js(...)
```

### Semantics of the three tools

- `page.read` = understand the page without mutating it
- `page.act` = interact with or mutate the page
- `page.js` = execute arbitrary JavaScript as an explicit fallback

### Action-dispatch model

`page.read` and `page.act` use an explicit `action` field.

Example:

```ts
page.read({ action: "inspect", ... })
page.act({ action: "click", ... })
page.js({ code: "..." })
```

For MCP and programmatic usage, `action` is a named field.

For CLI usage, the action may be provided positionally after the tool family name, for example:

```bash
browserpowers page read inspect
browserpowers page act click --anchor a1
browserpowers page act fill --anchor a2 --value "ada@example.com"
```

This is only a CLI presentation detail. The underlying API model still treats `action` as an explicit field.

## Target Model

### Structured target object

Page operations should move away from CSS-selector-only inputs and support a structured target object.

```ts
type Target =
  | { css: string }
  | { text: string }
  | { role: string; name?: string }
  | { label: string }
  | { placeholder: string }
  | { testId: string };
```

Notes:

- `css` remains supported as the low-level explicit selector path.
- `text`, `role`, `label`, and `placeholder` give the agent safer and more semantic ways to act.
- `testId` supports explicit page contracts when a site or app provides them.
- This is inspired by Playwright locator philosophy, but not intended to reproduce Playwright's full locator engine.

### Anchor-first targeting

Whenever possible, follow-up actions should prefer **anchors** returned by `page.read({ action: "inspect" })`.

Preferred targeting order:

1. `anchor`
2. semantic `target`
3. raw `css`
4. `page.js` only when the structured model cannot express the task

## Command Surface

### `page.read`

Preferred read actions:

```ts
page.read({ action: "inspect", target?, limit?, include_hidden? })
page.read({ action: "content", target? })
page.read({ action: "text", target })
page.read({ action: "html", target, limit? })
page.read({ action: "attr", target, name })
page.read({ action: "meta" })
page.read({ action: "forms" })
page.read({ action: "count", target })
```

### `page.act`

Preferred act actions:

```ts
page.act({ action: "click", anchor? , target? })
page.act({ action: "fill", anchor? , target? , value })
page.act({ action: "check", anchor? , target? , checked? })
page.act({ action: "select_option", anchor? , target? , value?, label? })
page.act({ action: "press", anchor? , target? , key })
page.act({ action: "scroll", anchor? , target? , direction?, amount? })
page.act({ action: "submit", anchor? , target? })
page.act({ action: "wait_for", anchor? , target? , state?, timeout_ms? })
```

### `page.js`

```ts
page.js({ code })
```

### Consequences for old commands

- many narrow top-level page tools are expected to be removed or remapped internally
- one-off helpers such as `page.smart_click` should be absorbed into `page.act({ action: "click", ... })`
- raw JavaScript moves conceptually under `page.js`, not the main declarative interaction surface

## Inspect and Anchors

### Purpose of inspect

`page.read({ action: "inspect" })` becomes the primary discovery tool for agents.

It should:

- summarize the current page
- list interactable elements
- assign small anchor ids
- provide enough metadata to let the agent choose the right element quickly
- reduce repeated target-resolution work across multi-step flows

### Anchor rules

Anchors are lightweight, ephemeral references to elements discovered during inspect.

They must be treated as:

- scoped to the current tab
- scoped to the current document or DOM epoch
- invalidated on navigation
- invalidated when the page changes enough that the reference is no longer trustworthy

Anchors are not permanent identifiers.

### Suggested anchor shape

```ts
interface AnchorRef {
  id: string;            // e.g. "a1"
  tabId: number;
  frameId?: string;
  documentId?: string;
}
```

### Inspect response format

Recommended shape:

```ts
interface InspectResultData {
  url: string;
  title: string;
  documentId?: string;
  anchors: Array<{
    anchor: string;
    role?: string;
    name?: string;
    label?: string;
    placeholder?: string;
    text?: string;
    tag: string;
    type?: string;
    visible: boolean;
    enabled?: boolean;
    checked?: boolean;
    selected?: boolean;
    target: Target;
  }>;
}
```

### Example inspect response

```json
{
  "success": true,
  "status": "performed",
  "action": "inspect",
  "message": "Found 12 interactable elements",
  "data": {
    "url": "https://example.com/settings",
    "title": "Settings",
    "documentId": "doc-42",
    "anchors": [
      {
        "anchor": "a1",
        "role": "button",
        "name": "Save",
        "text": "Save",
        "tag": "button",
        "visible": true,
        "enabled": true,
        "target": { "role": "button", "name": "Save" }
      },
      {
        "anchor": "a2",
        "role": "textbox",
        "label": "Email",
        "tag": "input",
        "type": "email",
        "visible": true,
        "enabled": true,
        "target": { "label": "Email" }
      }
    ]
  }
}
```

### Example follow-up actions with anchors

```json
{ "action": "fill", "anchor": "a2", "value": "ada@example.com" }
```

```json
{ "action": "click", "anchor": "a1" }
```

### Stale anchor failure behavior

If an anchor is no longer valid, the system should fail explicitly.

Example:

```json
{
  "success": false,
  "status": "blocked",
  "action": "click",
  "message": "Anchor a1 is no longer valid because the page changed",
  "errorCode": "ANCHOR_STALE",
  "recoverable": true,
  "suggestions": [
    "Run page.read with action=inspect again",
    "Use a semantic target instead of the stale anchor"
  ]
}
```

## Result Model

Every page tool must return explicit, agent-friendly feedback.

### Required result shape

```ts
interface ActionResult {
  success: boolean;
  status:
    | "performed"
    | "already_in_desired_state"
    | "not_performed"
    | "ambiguous"
    | "blocked";
  action: string;
  message: string;
  targetSummary?: string;
  evidence?: Record<string, unknown>;
  errorCode?: string;
  recoverable?: boolean;
  suggestions?: string[];
  data?: Record<string, unknown>;
}
```

### Semantics

- `success` communicates high-level success/failure
- `status` communicates the exact outcome class
- `message` is mandatory and should be understandable by both humans and agents
- `targetSummary` explains what was actually targeted
- `evidence` provides structured support for the outcome
- `errorCode` allows machine-friendly branching
- `recoverable` tells the agent whether retry or alternative action is reasonable
- `suggestions` gives useful next steps when something fails or is ambiguous
- `data` carries structured payloads such as inspect results

### Example success result

```json
{
  "success": true,
  "status": "performed",
  "action": "click",
  "message": "Clicked button 'Save'",
  "targetSummary": "anchor=a1 role=button name=Save",
  "evidence": {
    "matchedCount": 1,
    "tag": "button",
    "text": "Save"
  }
}
```

### Example no-op success result

```json
{
  "success": true,
  "status": "already_in_desired_state",
  "action": "check",
  "message": "Checkbox 'Subscribe' was already checked",
  "targetSummary": "label=Subscribe"
}
```

### Example failure result

```json
{
  "success": false,
  "status": "ambiguous",
  "action": "click",
  "message": "Found 3 matching 'Save' buttons; action aborted to avoid clicking the wrong one",
  "targetSummary": "role=button name=Save",
  "errorCode": "AMBIGUOUS_TARGET",
  "recoverable": true,
  "suggestions": [
    "Run page.read with action=inspect to choose an anchor",
    "Refine the target with a label, testId, or CSS selector"
  ],
  "evidence": {
    "matchedCount": 3
  }
}
```

## Behavior Rules

### Action execution expectations

For page actions, BrowserPowers should prefer:

- clear target resolution
- visible/usable checks where reasonable
- retry/wait behavior within a bounded timeout
- safe refusal when multiple matches create ambiguity
- direct use of anchors when valid

This borrows from Playwright's actionability mindset, but only as much as is useful for agent reliability.

### Required questions every action should answer

Each action result should make these points clear:

1. What was the action trying to do?
2. How was the target identified?
3. What actually happened?
4. How confident is the system in that result?
5. What should the agent do next if the action failed?

### Preferred workflow

Recommended agent workflow:

1. inspect the page with `page.read({ action: "inspect" })`
2. choose an anchor when possible
3. perform `page.act(...)` using that anchor
4. fall back to semantic targets when anchors are unavailable
5. use `page.js` only when read/act cannot express the task

## Consequences

### Positive

- The API becomes much smaller and easier to reason about.
- Agents get actionable results instead of thin pass/fail blobs.
- Targeting becomes more semantic and less brittle than CSS-only flows.
- Inspect anchors make follow-up interactions faster and less ambiguous.
- `page.js` remains available without dominating the model.
- The product differentiates itself from Playwright by being more explicit and agent-readable.

### Negative / Tradeoffs

- Existing tool names and input schemas will change.
- The extension router will need shared target-resolution and anchor-resolution logic.
- Anchor invalidation introduces lifecycle complexity.
- More effort is required to produce strong result messages and evidence.
- Some actionability checks will still be approximate compared to a full browser automation framework.

## Rejected Alternatives

### 1. Raw-JS-first interaction model

Rejected as the primary model.

Reason:

- too much ambiguity
- too much custom code generation for routine actions
- weak safety boundaries
- harder for agents to recover cleanly

### 2. Full Playwright-style surface clone

Rejected.

Reason:

- wrong scope for BrowserPowers
- high implementation cost
- misleading expectations about parity
- BrowserPowers controls real browsers through an extension bridge, not a dedicated browser automation runtime

### 3. Keep the current mixed model and add more one-off helpers

Rejected.

Reason:

- increases surface area without creating a clean mental model
- deepens inconsistency between selector-based, heuristic, and raw execution paths

### 4. Keep many top-level page tools but improve the docs

Rejected.

Reason:

- documentation alone does not solve the underlying API sprawl
- tool-family plus action-dispatch is a better long-term fit for MCP and CLI usage

## Migration Direction

Because the project is not public and no stable external contract exists yet, BrowserPowers may make a direct breaking transition.

Planned direction:

1. Define the v2 `page.read`, `page.act`, and `page.js` schemas.
2. Define the shared action result envelope.
3. Implement `inspect` and anchor generation.
4. Add anchor resolution and stale-anchor failure behavior.
5. Refactor page operations around action dispatch instead of many top-level tools.
6. Fold one-off helpers such as `page.smart_click` into the general action model.
7. Update MCP tool schemas, CLI commands, extension routing, tests, and documentation together.

## Implementation Notes for Delegation

Any implementation work based on this ADR should preserve these non-negotiables:

- page interaction is organized as **three top-level tool families**
- read and act use **explicit action types**
- targets are **structured objects**, not only raw selectors
- inspect returns **anchors** for fast follow-up interaction
- results always include **clear textual feedback**
- failures should be **safe, explicit, and recoverable where possible**
- `page.js` remains **available but exceptional**

## Open Questions

These questions remain for implementation design, not product direction:

- exact invalidation strategy for anchors and document ids
- whether `state` in `wait_for` supports only `attached` / `visible` initially or more
- how much frame and shadow-DOM targeting should be supported in v2
- whether inspect should group anchors by category or priority
- whether `page.js` should later support structured function + args alongside raw code

## Summary

BrowserPowers will not become a Playwright clone and will not become a raw-JS-first browser puppet.

It will instead expose a compact, agent-oriented page interaction model built around:

- `page.read`
- `page.act`
- `page.js`
- explicit action dispatch
- structured targets
- inspect-generated anchors
- explicit result envelopes
- safe ambiguity handling
- raw JavaScript as a gated escape hatch
