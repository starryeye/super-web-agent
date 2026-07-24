# Super Web Agent Desktop Integration and Rename Design

- Status: Approved
- Date: 2026-07-24
- Product name: Super Web Agent
- Short name: SWA
- Repository slug: `super-web-agent`

## 1. Decision Summary

Super Web Agent is a local-first browser state and execution layer for AI
desktop applications. The first public release supports both Codex Desktop and
Claude Desktop. Development completes the Codex Desktop vertical slice first,
then packages the same provider-neutral Runtime for Claude Desktop.

Users install two independent artifacts:

1. an SWA integration for their AI desktop application; and
2. the SWA Chrome Extension.

The desktop integration installs and manages the local Runtime. The Chrome
Extension connects that Runtime to the user's existing Chrome profile and
login sessions. Users do not provide OpenAI, Anthropic, or SWA API keys.

The project adopts the new identity as a clean break. Current source,
packages, protocols, documentation, repositories, and active branches use only
the new identity. Existing Git commit history remains unchanged.

## 2. Product Purpose

SWA helps an AI desktop application understand and operate the user's existing
Chrome with less context, fewer observations, and fewer model-browser
round-trips.

Existing browser tools often repeat a costly loop:

```text
observe a large DOM, accessibility tree, or screenshot
→ choose one low-level action
→ execute it
→ observe the page again
→ re-plan
```

SWA changes the normal path to:

```text
inspect a compact Agent Page Model
→ execute a validated multi-action plan
→ verify postconditions locally
→ return a compact result or semantic delta
```

The product succeeds when reproducible benchmarks show one or more of the
following improvements without reducing task success or safety:

- fewer agent observations and full snapshots;
- fewer tool calls and model-browser round-trips;
- fewer serialized bytes and provider-reported input tokens;
- lower end-to-end latency;
- better reference recovery after controlled rerenders;
- less vision fallback and user intervention.

SWA is not a new browser, an AI model, a hosted agent, a cloud API proxy, or a
mechanism for bypassing browser permissions. It does not perform high-risk
external side effects without trusted user approval.

## 3. Naming Contract

The rename uses one canonical form for each context:

| Context | Canonical form |
| --- | --- |
| Product display name | `Super Web Agent` |
| Short human-readable name | `SWA` |
| GitHub repository and local folder | `super-web-agent` |
| Codex and Claude package ID | `super-web-agent` |
| Root package | `super-web-agent` |
| Package scope | `@super-web-agent/*` |
| Runtime executable | `super-web-agent-runtime` |
| Public protocol namespace | `swa.*` |
| MCP-compatible short identifiers | `swa_*` |
| Environment variables | `SWA_*` |
| Public TypeScript class | `SuperWebAgent` |
| Short code variable | `swa` |
| Local data directory | `~/.super-web-agent` |

Human-facing prose uses `Super Web Agent` on first mention and `SWA`
afterward. Machine-facing identifiers use the lowercase slug or acronym form
defined above. No compatibility aliases for the former identity are added
because no public release depends on them.

The `docs/superpowers/` and `.superpowers/` paths retain their names because
they identify a development workflow rather than the product. Their existing
Git-ignore policy also remains unchanged.

## 4. Supported Desktop Surfaces

The first public release requires:

- Codex in the ChatGPT desktop application on macOS and Windows;
- Claude Desktop on macOS and Windows; and
- the user's existing Chrome installation.

Codex distributes SWA as a marketplace plugin with a
`.codex-plugin/plugin.json` manifest and bundled MCP configuration. Claude
Desktop distributes SWA as a local MCP Bundle (`.mcpb`). Both packages contain
the same platform-specific Runtime bytes for the same SWA version.

The Chrome Extension is a separate installation and release artifact. The
desktop packages and Chrome Extension remain separate components in one
canonical public source repository.

Current platform constraints are based on the official host documentation:

- [Build Codex plugins](https://learn.chatgpt.com/docs/build-plugins)
- [Install local MCP servers on Claude Desktop](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)

## 5. Architecture

```text
Codex Desktop
└── SWA Codex Plugin
    └── SWA Core Runtime A ─┐
                            ├── SWA Chrome Extension ── Existing Chrome
Claude Desktop              │
└── SWA Desktop Extension   │
    └── SWA Core Runtime B ─┘
```

The first release uses one Runtime process per AI desktop integration. This
keeps lifecycle ownership and failure isolation simple. The Chrome Extension
can maintain multiple authenticated Runtime pairings, but one Chrome tab has
only one active, expiring execution lease at a time.

The architecture remains provider-neutral below the thin desktop packages.
The Codex and Claude integrations contain packaging, lifecycle, host
instructions, and permission glue only. They do not duplicate Page Model,
reference, delta, action, policy, or benchmark logic.

### 5.1 Desktop Integration Responsibilities

Each desktop integration:

- installs and verifies the platform Runtime artifact;
- starts, supervises, and stops its Runtime process;
- exposes the Runtime as an MCP server to the host;
- presents pairing, compatibility, and recovery guidance;
- manages host-specific plugin metadata and permissions;
- updates the Runtime with the desktop package; and
- removes SWA-owned state when the host supports removal hooks.

### 5.2 Core Runtime Responsibilities

The provider-neutral Runtime owns:

- the Agent Page Model and progressive disclosure;
- semantic page deltas;
- recoverable references;
- typed actions and multi-step plans;
- preconditions, postconditions, and structured failures;
- policy classification and approval requests;
- Runtime, Agent, and Browser Session state;
- local traces and benchmark measurements; and
- the authenticated bridge protocol to the Chrome Extension.

The Runtime performs no external model inference and calls no OpenAI or
Anthropic model API.

### 5.3 Chrome Extension Responsibilities

The Chrome Extension owns browser-only capabilities:

- access to the user's existing Chrome tabs and login sessions;
- site, origin, and tab permission UI;
- DOM, ARIA, form, visibility, and geometry observation;
- browser action execution and low-level verification;
- mutation coalescing and resynchronization signals;
- exclusive tab-lease arbitration; and
- trusted approval UI for high-risk actions.

## 6. Installation and Pairing Experience

The target installation flow is:

```text
1. Install SWA in the signed-in Codex Desktop or Claude Desktop application.
2. Install the SWA Chrome Extension from the Chrome Web Store.
3. Start “Connect SWA” from the desktop application.
4. Confirm a short-lived, one-time local pairing code in the Chrome Extension.
5. Approve the Chrome tab or site that SWA may use.
6. Use SWA from the desktop conversation.
```

The user does not:

- create an SWA cloud account;
- provide an OpenAI, Anthropic, or SWA API key;
- install Node.js, Docker, or a separate Runtime;
- start a daemon or MCP server manually;
- select or enter a port;
- edit MCP configuration files; or
- move to another browser or login session.

The pairing code is not an account credential or API key. It is a
short-lived local authorization proof between one Runtime and the Chrome
Extension. After confirmation, each side stores a rotatable local credential
in its host-protected data area. The Runtime listens only on loopback and
rejects unauthenticated connections.

## 7. Security and Concurrency

The Chrome Extension is the trusted user-consent surface for browser access and
high-risk actions. A desktop application's approval cannot replace the
Extension's final approval for communication, financial, destructive, or other
externally consequential actions.

Each paired Runtime has a distinct identity. When Codex Desktop and Claude
Desktop run simultaneously, the Extension may connect to both, but it grants an
exclusive, expiring execution lease per tab. A Runtime must reacquire a lease
after expiration, disconnect, restart, or document replacement.

Runtime restart invalidates pending approvals, resume tokens, reference
registries, and active leases from the previous Runtime Session. A new document
invalidates references from the previous Document Epoch.

## 8. Error Handling

Errors are explicit, structured, and actionable:

| Condition | Required behavior |
| --- | --- |
| Chrome Extension missing | Return an install-required state with the official installation path. |
| Runtime not paired | Generate a new one-time pairing flow. |
| Runtime launch failure | Attempt bounded automatic restart, then return sanitized diagnostics. |
| Protocol or artifact version mismatch | Stop automatic use and request the required update. |
| Tab or origin permission missing | Ask through the Chrome Extension's trusted UI. |
| Runtime–Extension connection lost | Stop execution, discard unsafe transient state, reconnect, and resynchronize. |
| Tab lease held by another Runtime | Report the owner and require explicit handoff or lease expiry. |
| High-risk action reached | Pause and request Extension approval before the side effect. |
| Model-provider API key absent | Continue normally; such a key is not an SWA dependency. |

SWA never silently guesses after an ambiguous reference, unexpected
navigation, failed postcondition, changed critical value, or missing approval.

## 9. Existing Spike Disposition

The current architecture-spike work remains useful only where it proves
provider-neutral Runtime behavior.

Retain and rename:

- the self-contained Runtime artifact builder;
- macOS and Windows packaging evidence;
- artifact integrity checks;
- process start, stop, update, and crash-recovery logic;
- MCP stdio health checks;
- lifecycle journals and strict evidence schemas.

Replace:

- Claude Code CLI lifecycle adapters;
- Codex CLI model-call harnesses;
- model-provider API-key guards;
- model-call-dependent GitHub Actions gates;
- Claude Code marketplace fixtures.

The replacement evidence targets:

- Codex Desktop plugin packaging and installation;
- Claude Desktop `.mcpb` packaging and installation;
- keyless CI for deterministic package and protocol verification;
- Chrome Extension pairing and permission integration; and
- manual acceptance tests in signed-in desktop applications.

## 10. Repository and Branch Migration

The migration preserves all existing commit hashes and does not rewrite Git
history.

The sequence is:

1. create `codex/rename-super-web-agent` from the latest `origin/main`;
2. rename source, packages, documentation, protocols, workflows, and tests;
3. merge the rename through a pull request;
4. forward-merge the renamed `main` into
   `codex/plugin-lifecycle-workflow-bootstrap` and
   `codex/plugin-lifecycle-spike`;
5. rename branch-only files and identifiers without rebasing or force-pushing;
6. rename the GitHub repository to `starryeye/super-web-agent`;
7. update the shared Git remote to the new canonical URL;
8. move the local repository to `/Users/starryeye/play/super-web-agent`;
9. repair linked worktrees and verify every active branch; and
10. reopen the renamed workspace in the desktop application if required.

The local directory move happens last so the active workspace and linked
worktrees remain valid during source changes. User-owned caches and unrelated
untracked files are not modified.

## 11. Verification Strategy

Verification has four product layers plus a rename gate.

### 11.1 Unit and Protocol Tests

Test Page Model construction, reference recovery, delta generation, plan
validation, policy boundaries, session identity, and structured errors.

### 11.2 Packaging and Lifecycle Tests

On macOS ARM64 and Windows x64, verify Runtime artifacts, Codex plugin bundles,
Claude `.mcpb` bundles, integrity, installation, start, clean stop, update,
bounded crash recovery, and removal.

### 11.3 Chrome Integration Tests

Use public fixture pages to verify installation detection, pairing, permission
denial and grant, DOM observation, action execution, navigation, reconnect, and
full resynchronization.

### 11.4 Desktop Acceptance Tests

With no model-provider API-key environment variables:

- install the plugin in a signed-in Codex Desktop application;
- invoke an SWA MCP tool through the desktop conversation;
- repeat with a signed-in Claude Desktop application and the `.mcpb`;
- confirm both hosts use the expected Runtime artifact; and
- confirm uninstall leaves no live Runtime or SWA-owned residue.

### 11.5 Rename Gate

For `main` and every active feature branch:

- scan tracked current files for all former display, slug, and uppercase
  identifier variants;
- require zero matches outside historical Git objects;
- run all tests, type checks, builds, and workflow validation;
- verify package names, executable paths, and generated artifacts;
- verify the canonical GitHub remote URL; and
- verify the main worktree and both linked worktrees.

## 12. Delivery Order

Work proceeds in this order:

1. publish the approved design and complete the repository-wide rename;
2. replace the current authenticated CLI lifecycle gate with keyless evidence;
3. complete the Codex Desktop installation-to-Chrome vertical slice;
4. package the same Runtime as a Claude Desktop `.mcpb`;
5. complete cross-host lifecycle, pairing, and Chrome integration evidence; and
6. begin the Page Model and action-execution production slices only after the
   desktop lifecycle gate passes.

No implementation milestone may claim simplified installation, improved
performance, or desktop compatibility without the corresponding verification
evidence.
