# Control DB contracts — consolidated requirements inventory

Local sub-issue: [03.02 — Consolidate the Control DB contracts required by
consuming tasks](../../../context/notion-tasks/sub-issues/03-02.md), under
parent [03 — Create control Prisma schema](../../../context/notion-tasks/03-control-prisma.md).

## 0. Purpose and boundaries

This document consolidates, with full traceability, every field, relation,
lifecycle state, and constraint that a local consuming-task guide explicitly
requires for the eight areas this sub-issue covers: **identity, session,
project, membership, invitation, draft, job, audit**. It is an **inspection
and documentation deliverable only**:

- It does **not** define, approve, or implement a Prisma schema. No model,
  field name, or type below is a finalized schema element — each is labeled
  by its evidentiary status (explicit / engineering inference / conflicting
  / unspecified) and traced to the exact guide and field it comes from.
- It does **not** resolve the `PROJECT_OWNER`/`PROJECT_ADMIN` conflict or any
  other contradiction found below — those are recorded as decision gates for
  [03.03](../../../context/notion-tasks/sub-issues/03-03.md) (role/ownership)
  and, where schema-relevant but not role-related, flagged for 03.04 to
  resolve with the user before implementation.
- No implementation code, Prisma schema, migration, generated client, or
  package export was changed to produce this document.

It builds on, and does not duplicate, [`control-database-inventory.md`](control-database-inventory.md)
(sub-issue 03.01's verified baseline: `@relis/database`'s current empty
state, the migration entry point, and existing test coverage) — consult that
document for the current-state package/Prisma/test inventory.

## 1. Scope and source inventory

**Sources read in full for this document** (all local; no Notion, GitHub, or
other external browsing was performed, per this task's instructions):

- [`control-database-inventory.md`](control-database-inventory.md) (03.01 baseline).
- [`packages/contracts/package.json`](../../packages/contracts/package.json) and
  [`packages/contracts/src/index.ts`](../../packages/contracts/src/index.ts) (code-inspected).
- [`context/notion-tasks/PENDING-DECISIONS.md`](../../../context/notion-tasks/PENDING-DECISIONS.md) (items 1, 2, 3, 6, 7, 11, 14, 19 are directly relevant here and are cited by number throughout).
- Consuming-task guides, read in full:
  [06 — job platform](../../../context/notion-tasks/06-job-platform.md),
  [07 — storage](../../../context/notion-tasks/07-storage.md),
  [08 — installation/demo](../../../context/notion-tasks/08-installation-demo.md),
  [09 — login/sessions](../../../context/notion-tasks/09-login-sessions.md),
  [10 — registration](../../../context/notion-tasks/10-registration.md),
  [11 — password reset](../../../context/notion-tasks/11-password-reset.md),
  [12 — profile](../../../context/notion-tasks/12-profile.md),
  [13 — admin users](../../../context/notion-tasks/13-admin-users.md),
  [14 — Google OIDC](../../../context/notion-tasks/14-google-oidc.md),
  [15 — membership](../../../context/notion-tasks/15-membership.md),
  [16 — project template/provisioning](../../../context/notion-tasks/16-project-template.md),
  [17 — project DB resolver](../../../context/notion-tasks/17-project-resolver.md),
  [18 — protocol wizard](../../../context/notion-tasks/18-protocol-wizard.md),
  [19 — project lifecycle](../../../context/notion-tasks/19-project-lifecycle.md),
  [20 — project workspace](../../../context/notion-tasks/20-project-workspace.md) (Data model section only, for its one Control DB addition),
  [21 — project settings](../../../context/notion-tasks/21-project-settings.md),
  [22 — audit/undo](../../../context/notion-tasks/22-audit-undo.md),
  [23 — system settings](../../../context/notion-tasks/23-system-settings.md) (read as a cross-reference for where configuration values named by other guides — e.g. invitation validity, registration mode, Google OIDC enablement — are likely owned; **not** one of this sub-issue's eight domains),
  [39 — CSV/BibTeX reporting exports](../../../context/notion-tasks/39-csv-bibtex-exports.md) and
  [40 — Python/R statistical exports](../../../context/notion-tasks/40-python-r-exports.md) (read to reconcile their explicit direct-streaming, no-job, no-persistence contract against the generic job/storage expectations in 06/07 — see §3.7 and decision gate §5.11; **not** a new domain, and no export feature is designed here),
  [41 — backup/restore and hardening](../../../context/notion-tasks/41-backup-hardening.md) (read solely because 22 — UI behavior explicitly defers audit retention/anonymization to it; see the cross-reference note after §3.8 and decision gate §5.12 — **implementing 41 remains entirely out of scope for this sub-issue**, and no backup/restore schema is proposed here).

**Citation convention:** every row below cites a guide file and the exact
Notion-card field it was reproduced under (e.g. "15 — Data model", "18 — API
behavior"). These are the guides' own reproduced section names, not new
numbering invented here.

**Status labels used throughout** (per this sub-issue's AC requirement that
every field carry one):

- **explicit** — stated directly in a source field.
- **inference** — a reasonable engineering consequence of an explicit
  requirement, not itself stated (e.g., a field needed to implement a stated
  behavior, but whose name/shape the source never gives).
- **conflicting** — two or more sources disagree; see §5 for the decision
  gate.
- **unspecified** — a behavior is explicitly required but its data
  representation is not given anywhere in the read sources; recorded as a
  gap, not invented.

## 2. Implemented contracts vs. future requirements

- **`@relis/contracts`** ([`package.json`](../../packages/contracts/package.json),
  [`src/index.ts`](../../packages/contracts/src/index.ts)) exists and is
  workspace-registered, but its entire source is `export { z } from "zod";`
  — it re-exports the Zod library itself and defines **zero** domain
  schemas. A repository-wide search for `@relis/contracts` as an imported
  specifier found no consumers anywhere in `apps/*` or `packages/*` — nothing
  currently imports it.
- **`@relis/database`**: per the 03.01 baseline, `index.ts` is `export {};`
  and both Prisma schemas are model-free (see that document's §2–§3 for full
  detail; not repeated here).
- **Conclusion: every field, contract, and relation in §3 below is a future
  requirement.** Nothing in this inventory has an implemented counterpart in
  this checkout today. This document does not change that — it is the input
  03.04/03.05 will design against.

## 3. Field-and-relation traceability matrices

Each table's **Ownership** column uses: **Control DB**, **Project DB**,
**External** (object storage, the job queue's own internal tables, or
managed secret/key configuration — never a Prisma model in either database),
or **Unresolved**.

### 3.1 Identity (User, Credential, ExternalIdentity)

| Field / relation | Source (file — section) | Behavior requiring persistence | Ownership | Constraints | Status |
| --- | --- | --- | --- | --- | --- |
| User: immutable ID | 15 — Data model | Every reference from membership, invitation, session, audit | Control DB | Immutable | explicit |
| User: unique normalized username | 15 — Data model | Exact-match lookup for adding/inviting members (15 — API behavior); admin directory search (13 — UI behavior) | Control DB | Unique, normalized | explicit |
| User: unique normalized email | 15 — Data model | Login (09), registration (10), reset (11), profile email change (12), Google-identity email check (14) | Control DB | Unique, normalized | explicit |
| User: email-verification state | 15 — Data model; 10 — Behavior; 14 — API behavior ("require the email to be provider-verified") | Gates protected-feature access until verified (10 — Users/permissions) | Control DB | — | explicit (exact enum values not given) |
| User: account status (active / archived / disabled / unverified) | 15 — Data model ("account status"); 09 — Users/permissions (rejects archived/disabled/unverified); 13 — Data model ("active/archive state") | Login eligibility gate (09); admin archive/restore (13) | Control DB | Archived users cannot log in or receive new assignments but keep historical attribution (13) | explicit behavior, **unspecified** representation — sources name at least 3 overlapping states (archived/disabled/unverified) without stating whether they are one enum or independent flags |
| User: Application-Administrator authority (global role) | 13 — Data model ("global roles") | Gates system-wide user directory and settings access (13, 23) | Control DB | The final active Application Administrator cannot be archived or demoted (13 — Acceptance criteria) | explicit — distinct from the project-scoped role in §3.3, not the same enum |
| User: timestamps | 15 — Data model | Audit, directory sorting | Control DB | — | explicit (generic, no field names given) |
| Credential: password hash | 09 — Data model | Login verification | Control DB | `crypto.scrypt`, constant-time compare | explicit |
| Credential: scrypt parameter version | 09 — Data model | Triggers rehash after login when parameters are upgraded | Control DB | Versioned | explicit |
| Credential: per-credential random salt | 09 — Data model | Password hashing | Control DB | ≥16 bytes, cryptographically random | explicit |
| Credential: last-login audit data | 09 — Data model | — | Control DB | — | explicit, unspecified exact shape |
| (JWT signing keys) | 09 — Data model | Session issuance/validation | **External** (managed secret/key config) | Must include a `kid`; explicitly **not** a database field | explicit |
| Email-verification token: digest, expiry, consumed timestamp, retry metadata | 10 — Data model | `register`/`verify-email`/`resend-verification` | Control DB | Single-use, expiring, digest only (never plaintext); new token invalidates the previous one | explicit |
| Registration audit data | 10 — Data model | — | Control DB | — | explicit, but possibly redundant with the general `AuditEvent` model in §3.8 — unclear whether this is a distinct field set or just means "an `AuditEvent` is written"; **unspecified** |
| Registration mode (public / disabled / admin-managed) | 10 — Behavior/API behavior | Gates which registration path is active | **Unresolved** | — | explicit requirement, but likely owned by the system-settings registry (23 — Data model: "typed global settings"), not a User/identity field — out of this sub-issue's 8 domains; flagged, not assigned |
| Password-reset token: digest, expiry, consumption metadata | 11 — Data model | `request-password-reset`/`validate-reset-token`/`complete-reset` | Control DB | Single-use, digest only, same pattern as §10's token | explicit |
| Force-reset flag "where needed" | 11 — Data model | `administrator-force-reset` | Control DB | Administrator never sees/sets the password or token | explicit requirement, **inference** on representation — the source's own hedge ("where needed") leaves open whether this is a persisted flag or purely a code path |
| Profile: display/profile fields | 12 — Data model | `get-my-profile`/`update-my-profile` | Control DB | Editable-field allowlist excludes authority/role/status/verification (12 — Users/permissions) | explicit requirement, **unspecified** which exact fields ("profile fields" is generic; 12's own Acceptance criteria are empty) |
| Profile: preferred locale | 12 — Data model | Drives the localization resolver (12 — Behavior) | Control DB | — | explicit |
| Profile: pending-email-change token metadata | 12 — Data model; 12 — API behavior (`start-email-change`/`confirm-email-change`) | Verified email change flow | Control DB | Previous verified email stays authoritative until confirmed | explicit requirement; **inference** on exact shape (digest/expiry pattern assumed by analogy to §10/§11's tokens, not independently stated for profile) |
| Profile: profile-image storage reference | 12 — Data model | `upload-profile-picture`/`remove-profile-picture` | Control DB holds the reference; **External** (file storage) holds the object | Type/size validated before availability (12 — API behavior; cross-reference 07 — storage) | explicit |
| Admin: archive/restore actor + timestamp metadata | 13 — Data model ("administrator action metadata") | `archive-user`/`restore-user`/`assign-application-administrator` | Control DB | — | explicit, unspecified exact shape |
| Cross-DB constraint: historical attribution survives archive | 13 — Data model ("Project DB: no user deletion; project review records retain their original user identity/reference") | Preserves review attribution after a user is archived | **Cross-cutting** — Control DB never hard-deletes a User row; Project DB rows keep referencing the Control DB user ID even after archive | No hard delete anywhere in this domain | explicit — important architectural note: this is **not** a real foreign key (separate physical databases), so 03.04 must decide how this reference is validated/maintained |
| ExternalIdentity: `(provider, provider_subject)` unique pair, verified email snapshot, link timestamps | 14 — Data model | Google OIDC sign-in and account linking | Control DB | Unique `(provider, sub)`; never looked up by email alone | explicit |
| OIDC login transaction: state digest, PKCE verifier (protected/encrypted server-side only), nonce, return path, created/expiry/consumed | 14 — Data model | Authorization-code + PKCE flow | Control DB | Short-lived, single-use; verifier never leaves protected server-side state | explicit |
| (Google tokens: ID/access/refresh) | 14 — Data model | — | **Not persisted at all** | Explicitly never stored, logged, or returned | explicit prohibition, not a field |

### 3.2 Session

| Field / relation | Source (file — section) | Behavior requiring persistence | Ownership | Constraints | Status |
| --- | --- | --- | --- | --- | --- |
| Session: server-side session/revocation record | 09 — Data model ("server session/revocation metadata") | Every protected request validates "session ID, and revocation/token version" (09 — API behavior) | Control DB | Revoked session rejected even with an otherwise-valid token | explicit requirement, **unspecified** exact field names beyond "session ID" and "revocation/token version" |
| "Revoke all sessions for an account" semantics | 11 — Behavior/API behavior ("revokes existing active sessions"); 13 (force-reset implies the same) | Password change/reset; administrator force-reset | Control DB | Must invalidate every active session for the account, not just the current one | explicit behavior, **inference** on mechanism — a per-session revoked flag vs. a per-user token-version counter are both consistent with the source; neither is specified |
| JWT claims (subject, session ID, iat/exp, issuer, audience, token ID, token version) | 09 — API behavior/Data model | Minimal, stateless claim validation | **External** — these are token claims, not a database table, though `sessionId`/`tokenVersion` must correlate to the stored session record above | Must **never** contain project role, permission, or active project | explicit |
| Google sign-in session | 14 — Data model ("use the shared user, account-status, session, token-version, and audit records... do not duplicate session/JWT tables for Google") | Google OIDC success issues the same session | Control DB (same model as above) | No parallel session/JWT model for Google | explicit — confirms Session is a single shared model, not duplicated per auth method |

### 3.3 Project

| Field / relation | Source (file — section) | Behavior requiring persistence | Ownership | Constraints | Status |
| --- | --- | --- | --- | --- | --- |
| Project: internal UUID | 16 — API behavior; 18 — API behavior | Derives the Project DB identifier — "never from the project title or short name" | Control DB | Immutable | explicit |
| Project: title | 18 — UI behavior (wizard step 1); 19 — Data model | Display, search (19 — UI behavior: "search by project title or Project Owner name") | Control DB | Required | explicit |
| Project: unique short name | 18 — UI behavior/API behavior; 19 — UI behavior ("short name is read-only") | Uniqueness "enforced with a Control DB constraint, not only client-side" (18 — API behavior) | Control DB | Required, unique, immutable after creation | explicit |
| Project: description | 18 — UI behavior; 19 — UI behavior (owner-editable) | — | Control DB | Optional | explicit |
| Project: ordered research questions (+ optional description each) | 18 — UI behavior; 21 — Data model ("Research Questions and their display order") | Wizard step 1; direct-editing in Settings (21) | Control DB | Reorder via move-up/move-down only; backend manages the actual order value — no client-editable numeric order field (21 — UI/API behavior) | explicit |
| Project: `createdByUserId` | 18 — API behavior; 19 — Users/permissions (`currentUserId === project.createdByUserId`) | Determines Project Owner and edit authority | Control DB | Immutable; never accepted from the client; backend enforces correspondence with the protected `PROJECT_OWNER` membership (18) — **decided**: 1:1 in the current scope, unsupported-for-transfer (not a permanent prohibition on a future, separately approved transfer feature); see [`control-database-role-decision.md`](control-database-role-decision.md) §3.3/§6 | explicit — ownership-transfer question resolved for the current scope |
| Project: lifecycle state (`PROVISIONING` → ready/active) | 16 — Data model/API behavior; 18 — API behavior | Gates when the project and owner membership activate | Control DB | Activated only after Project DB ready **and** `v1` protocol persisted (18) | explicit |
| Project: displayed status set (`Draft`, `Provisioning`, `Active`, `Published`, `Archived`) | 19 — UI behavior | `/projects` list filtering | Control DB | — | explicit display requirement; **important distinction, not a contradiction**: "Draft" here denotes a creation **draft** (§3.6), which is not a Project row at all — 19 merges drafts into the same visual list but the underlying entity differs; 03.04 must not collapse draft-existence and `Project.state` into one field |
| Project: provisioning metadata — idempotency key, template release identifier, job reference, safe failure code/message | 16 — Data model | Idempotent provisioning request/retry | Control DB | Retrying must not duplicate the project/membership/database (16 — Acceptance criteria) | explicit |
| Project: publication state (Published/Unpublished) | 19 — UI behavior ("Publish/Unpublish project") | Public-projects visibility (19 — UI behavior) | Control DB | Published projects are read-only for non-members (19) | explicit requirement; **unspecified** relationship between this dimension and the provisioning lifecycle state above (can a project be simultaneously `Active` and unpublished? sources imply yes but never state the two state machines' interaction) |
| Project: archive metadata | 19 — Data model | Archive/restore | Control DB | Reversible via explicit restore (19 — UI behavior) | explicit, unspecified exact fields |
| Project: cover image reference | 20 — Data model | Project card display | Control DB holds the reference; **External** object likely, by analogy to the profile-picture pattern (§3.1) | — | explicit field name; **inference** on storage split (20 itself does not state where the image bytes live, only that Control DB holds "a cover image reference") |
| Project: created/last-modified timestamps | 19 — Data model | Sort by creation/modified date (19 — UI behavior) | Control DB | — | explicit |
| Project ↔ Project DB connection mapping | — (no source states this) | The resolver (17) must map a `projectId` to its physical, ready Project DB | **Unresolved** | — | **unspecified / gap** — 17's own Data model field is empty ("Data model: Empty"), and 16's Data model does not list a connection-string/identifier field either (16 explicitly forbids exposing one to the client, but says nothing about its internal persisted form). This is a genuine missing-information gap, not merely an inference; see §5 |

### 3.4 Membership

| Field / relation | Source (file — section) | Behavior requiring persistence | Ownership | Constraints | Status |
| --- | --- | --- | --- | --- | --- |
| Membership: `projectId`, `userId` | 15 — Data model | Authorization boundary for every project-scoped request (15 — API behavior) | Control DB | Exactly one active membership per `(projectId, userId)` | explicit |
| Membership: role | 15 — Data model (`PROJECT_ADMIN`, `PROJECT_MANAGER`, `REVIEWER`, `VALIDATOR`, `GUEST`) | Role-based authorization everywhere project-scoped | Control DB | Exactly one project role per active membership (15 — Users/permissions) | **decided** (formerly conflicting) — canonical enum is `PROJECT_OWNER, PROJECT_MANAGER, REVIEWER, VALIDATOR, GUEST`: 15's `PROJECT_ADMIN` is renamed to `PROJECT_OWNER`, not a sixth value added; see [`control-database-role-decision.md`](control-database-role-decision.md) §3.1/§4, which closes decision gate §5.1 |
| Membership: status (`PENDING_PROVISIONING`, `ACTIVE`, `REMOVED`) | 15 — Data model (`ACTIVE`/`REMOVED`); 18 — API behavior (`PENDING_PROVISIONING`, owner-only, pre-activation) | Removal/restoration; owner membership exists before the project is ready | Control DB | Activated only once Project DB ready + `v1` persisted; the Owner row never reaches `REMOVED` through any membership endpoint (role-decision §6) | **decided** (formerly unreconciled) — three-value enum confirmed, `PENDING_PROVISIONING` applies only to the Owner's initial row; see [`control-database-role-decision.md`](control-database-role-decision.md) §6, closing the status-enum half of decision gate §5.1 |
| Membership: actor, timestamps, removal reason | 15 — Data model | Audit trail for membership changes | Control DB | — | explicit |
| Last-protected-member guard | 15 — Acceptance criteria ("Removing the last Project Admin is rejected") vs. 15 — API behavior ("does not violate the last-Project-Manager guard") | Prevents a project from losing its protected member | Control DB | The Owner's protection is absolute and not count-based; there is **no** Manager-count floor (role-decision §3.2) | **decided** (formerly conflicting within the same guide) — both phrases are read as describing the Owner's now-unconditional protection; the "last-Project-Manager guard" phrase specifically is **rejected** as a real, independent rule; see [`control-database-role-decision.md`](control-database-role-decision.md) §3.2/§4, closing decision gate §5.2 |
| Project Manager cannot remove Project Admin | 15 — Users/permissions | Role-change/removal authorization | Control DB (business rule, not a field) | — | **decided** — now a redundant restatement: *nobody* (not only Project Manager) can remove or role-change the `PROJECT_OWNER` membership, including Application Administrator (role-decision §3.3/§6) |
| Historical attribution preserved on removal | 15 — Audit | Removing a membership "revokes access but never deletes the global account or historic project work" | Control DB / Project DB (cross-cutting, same note as §3.1) | — | explicit |
| "Project DB contains no user identities, passwords, invitations, roles, or membership copies" | 15 — Data model | — | Explicit **negative** ownership statement | — | explicit — directly supports this sub-issue's "preserve domain boundaries" requirement: no membership duplication into the Project DB under any circumstance |

### 3.5 Invitation

| Field / relation | Source (file — section) | Behavior requiring persistence | Ownership | Constraints | Status |
| --- | --- | --- | --- | --- | --- |
| Invitation: `projectId`, normalized email, proposed role | 15 — Data model | `create-invitation` | Control DB | — | explicit |
| Invitation: status (`INVITED`, `ACCEPTED`, `EXPIRED`, `CANCELLED`) | 15 — Data model | Invitation lifecycle | Control DB | — | explicit |
| Invitation: token hash, expiration time | 15 — Data model | Accept flow validates token/expiry | Control DB | Single-use, securely random, hash only (never plaintext) | explicit |
| Invitation: inviter, accepted user ID, sent/accepted timestamps | 15 — Data model | Audit, accept flow | Control DB | — | explicit |
| At most one active invitation per `(projectId, normalizedEmail)` | 15 — Data model/Acceptance criteria | Resend invalidates the prior invitation | Control DB | Enforced at the data layer, not only in the UI (15 — Definition of Done) | explicit |
| Invitation-expiry period: 7 days vs. 48 hours | 15 — UI/API behavior ("expires after the invitation-validity period... by default 7 days") vs. 15 — Jobs behavior ("expire invitations after 48 hours") | Token expiry, scheduled cleanup | Control DB (the value); likely system-settings-owned (23) for the configurable default | Expired invitations cannot be accepted | **conflicting** — PENDING-DECISIONS item 3; see decision gate §5.3 |
| Invitation-validity-period storage location | 15 — UI behavior ("configured by the Application Administrator") | Determines the default above | **Unresolved** | — | explicit requirement that *some* admin-configurable value exists; **unspecified** where (23's settings registry is generic and names no specific keys) |
| Re-check for an existing account before sending | 15 — UI behavior | "Invite user" performs a final email lookup; shows matching-account flow instead of sending if found | Control DB (business rule, not a field) | — | explicit |
| Invitation email delivery | 15 — Jobs behavior | "existing transactional email job mechanism" | **External** (job platform, §3.7) — the invitation row itself stays in Control DB; delivery is a job side-effect | Failed delivery visible to managers without exposing SMTP internals; retries must not create duplicate invitations/tokens | explicit |

### 3.6 Draft (project-creation drafts only)

| Field / relation | Source (file — section) | Behavior requiring persistence | Ownership | Constraints | Status |
| --- | --- | --- | --- | --- | --- |
| Draft: owner (creator) | 18 — Data model/Users permissions | Autosave/resume scoped to creator + audited admin access | Control DB | Never an arbitrary authenticated user — only the creator or an audited Application Administrator (18 — Definition of Done) | explicit |
| Draft: current wizard step | 18 — Data model | Resume mid-wizard | Control DB | — | explicit |
| Draft: autosaved payload (JSONB) | 18 — API behavior/Data model | Autosave, JSON export, JSON import prefill all reuse the same versioned contract | Control DB | Stored as JSONB; same shared `ProjectCreationDraft` Zod contract for autosave/import/export | explicit |
| Draft payload version/envelope | 18 — API behavior ("versioned configuration envelope") | Rejects an unsupported format version on import | Control DB (part of the JSONB payload) | — | explicit requirement; **unspecified** exact envelope/version field name |
| Idempotency key for final confirmation | 18 — API behavior | Prevents duplicate Project/membership/job/database on a repeated confirm | Control DB | — | explicit requirement; **unspecified** whether this key lives on the Draft row itself or a separate request-dedup record |
| Draft is never a Project | 18 — API behavior ("drafts are not projects and must never trigger Project DB provisioning") | — | Explicit negative constraint | — | explicit |
| Draft disposition after successful conversion | — (no source states this) | A confirmed draft becomes a Project; what happens to the Draft row itself is never stated | **Unresolved** | — | **unspecified / gap** — deleted, archived, or retained-and-linked are all consistent with the read sources; none is stated. 19 shows unfinished drafts in "My projects" but says nothing about *finished* ones |
| Scope boundary vs. post-creation protocol revisions | 21 — Description/Acceptance criteria ("no protocol-revision draft/version-comparison/activation/rollback... UI is present") | Explicit prohibition | — | — | explicit — this sub-issue's own instruction (do not introduce drafts/revisions where prohibited) is directly satisfied by source: the Draft entity here is strictly the **pre-creation** wizard draft; it must not be generalized into a revision mechanism for already-active projects (21 forbids that outright, while also self-contradicting elsewhere — see decision gate §5.6) |

### 3.7 Job (application metadata only — not the queue engine's own tables)

| Field / relation | Source (file — section) | Behavior requiring persistence | Ownership | Constraints | Status |
| --- | --- | --- | --- | --- | --- |
| pg-boss's own internal tables | 06 — Data model ("pg-boss tables live in the Control DB") | Queue mechanics | **External** — physically co-located in the Control DB's PostgreSQL instance, but these are the queue engine's private implementation, not a schema element this inventory models | — | explicit; per this sub-issue's own instruction, **no queue-engine selection is made or implied here** — `stack.yml`'s `pg-boss`/`BullMQ` decision (PENDING-DECISIONS item 1) remains open regardless of what 06's own Notion card happens to name |
| Job metadata: actor, project scope, progress, safe error message, correlation ID, result-artifact references, idempotency key, audit links | 06 — Data model | `enqueueJob`/`getJobStatus`/`listJobs`/`retryJob`/`cancelJob` | Control DB | Payloads carry opaque project IDs/source references — never credentials or raw secrets | explicit |
| Job visibility scoping | 06 — Users/permissions | `listJobs`/`getJobStatus` | Control DB (authorization rule, not a field) | Application Administrators see all; Project Admins see only their project's jobs; other roles see only what their feature surfaces | explicit |
| Cross-references requiring a job/correlation reference elsewhere | 16 — Data model (`job reference`); 18 (`provisioning job/outbox record`); 15 — Jobs behavior (invitation email job); 07 (export job-backed status — the **generic** case); 22 (idempotent compensating-action job) | Every listed consumer links back to a job record | Control DB | — | explicit — confirms Job metadata is a genuinely shared platform model, not duplicated per feature. **39/40 below are an explicit, named exception to the "07 export job-backed status" generic case** — do not assume every export is job-backed |
| CSV/BibTeX direct-stream exports: **no** job, worker, retention, or artifact table | 39 — Data model ("No generated-file, export-job, worker-job, retention, or artifact tables are required"); 39 — Acceptance criteria ("No worker, export history, retry, expiry, revoke, or path-based download flow is implemented") | Generates and streams the file directly in the HTTP response | **Not job-backed at all** — explicitly bypasses the Job platform entirely | File is never persisted; no download URL is ever generated; client supplies no path/filename | explicit negative requirement — **conflicts with 06/07's generic job-backed/persisted-export expectation**; 39's own Gaps section states this directly and instructs following "this ticket's specific direct-streaming contract, not the generic one" once the permission question below is resolved — see decision gate §5.11; this document does **not** silently pick a side or imply every export must skip jobs |
| CSV/BibTeX export audit event: export type, actor, timestamp, exported Paper count | 39 — Data model ("Store a lightweight export audit event only") | Every generation writes this one lightweight record | Likely **Project DB** (39 queries "only the current Project DB" and reuses existing Project DB records; 40's directly-named equivalent below is explicit about this) | "nothing more (no job record, no retry/expiry/revoke state)" (39 — Definition of Done) | explicit requirement; **inference** on exact ownership — 39 itself never names the database for this event, unlike 40 |
| `ReportingExportAudit`: actor, language (Python/R), category-type configuration snapshot, reportable Paper count, created time, generation result | 40 — Data model ("Add `ReportingExportAudit` in the Project DB") | Every Python/R export generation | **Project DB** (explicit) | "No generated-file storage is required" (40 — Data model) | explicit — a distinct, feature-specific record, **not** an instance of the general `AuditEvent` model in §3.8; do not conflate the two |
| Python/R exports: **no** persisted ZIP/CSV; Python/R never executed on the server | 40 — Data model/API behavior/Acceptance criteria | Streams the archive directly to the browser | **Not job-backed**, same exception as the CSV/BibTeX row above | Generated scripts treat labels/values strictly as data (never executed) | explicit negative requirement — same conflict with 06/07's generic model, same deferral to decision gate §5.11 |

### 3.8 Audit (and its distinct sibling, undo state)

| Field / relation | Source (file — section) | Behavior requiring persistence | Ownership | Constraints | Status |
| --- | --- | --- | --- | --- | --- |
| `AuditEvent` (control-plane scope): schema version, actor, scope, project ID (nullable), action, target, outcome, correlation ID, timestamp, redacted metadata | 22 — Data model | Every sensitive control-plane mutation (13, 15, 16, 18, 19, 21, 23 all require an audit write) | Control DB | **Append-only** — "no update or hard-delete code path... anywhere in the codebase" (22 — Definition of Done); metadata redacted/structured, never raw payloads/credentials | explicit |
| `AuditEvent` (project-resource scope) | 22 — Data model ("Each Project DB holds project-resource events") | Same shape, project-specific mutations | **Project DB** — a physically separate table/model per project database, **not** the same row-store as the control-plane event above | — | explicit — per this sub-issue's own instruction, these two must **not** be assumed to share a model or retention policy; they are explicitly split by the source |
| `OperationBatch`: original action, initiator, affected-resource snapshot/count, state, cancellation/compensation references, expiry, reason | 22 — Data model | Legacy-equivalent of project `operations` table; feeds the Undo centre | **Project DB** (per 22's own Data model: "Each Project DB holds... `OperationBatch`/`CompensatingAction` records") | — | explicit |
| `CompensatingAction` | 22 — Data model/API behavior | `previewCompensatingAction`/`executeCompensatingAction`, only for operations with a **registered** handler | Project DB (co-located with `OperationBatch`) | Revalidates authorization/state/dependencies at execution time even after a prior "safe" preview | explicit — distinct model from `AuditEvent`; undo eligibility is a separate concept, not derivable from the audit log alone |
| Cross-project operation correlation metadata | 22 — Data model ("the Control DB holds... cross-project operation correlation metadata") | Lets an Application Administrator search/filter operation history **across** projects (22 — Users/permissions) | Control DB | — | explicit requirement; **unspecified / gap** — no source states the exact shape of this correlation record, nor how a cross-project search avoids fanning out to every Project DB at query time; flagged in §5.9 |
| Retention/anonymization | 22 — UI behavior ("Retention or anonymization is handled through the dedicated hardening policy [41]"); 41 — Data model | Governs eventual retention/anonymization of application data; 22 explicitly routes audit-history retention through this mechanism rather than any direct UI delete action | Control DB (backup catalogue, encrypted-artifact metadata, restore plans/runs, **versioned** retention-policy records, confirmation tokens, global audit events); Project DB (project-scoped backup/restore audit references); **External** (encrypted controlled backup storage, opaque object keys) | Retention rules are versioned policy records, "never a destructive unlogged cron configuration" (41 — Data model); no `runSql`/generic SQL console anywhere (41) | explicit cross-domain dependency — see the reconciliation note and decision gate §5.12 immediately below for the open tension with this table's own `AuditEvent` append-only/no-delete row above |

**Guide 41 cross-reference — scope and reconciliation.** 41 was read in full because 22 — UI behavior names it explicitly ("Retention or anonymization is handled through the dedicated hardening policy") as the only authorized path for ever retiring audit history; its requirements therefore bear directly on this sub-issue's Audit domain even though 41 itself is not one of the eight domains in scope. **Implementation of 41 (backup/restore workflows, encrypted artifact storage, restore plans, a retention-policy UI) remains entirely out of scope for 03.02–03.05** — no such schema is proposed anywhere in this document, consistent with this correction's instruction not to expand this inventory into a complete backup-system design. That is a narrower claim than "41's requirements need not be analyzed": they were read, and their implication for ownership (an additional Control DB catalogue + Project DB reference + external encrypted-storage pattern, structurally consistent with this document's existing "External" bucket) is recorded above.

The open reconciliation: §3.8's own `AuditEvent` row states it is "append-only... no update or hard-delete code path... anywhere in the codebase" (22 — Definition of Done), stated as an absolute. 41 describes a **separate, governed, job-driven, versioned-policy mechanism** that can eventually retire data under an approved retention/anonymization policy, and 22 explicitly says *that* mechanism — not an ad hoc UI action — is how audit history would ever be retired. Neither source states whether `AuditEvent` rows themselves are ever in scope for a 41-driven retention/anonymization action, or whether `AuditEvent`'s "no update or hard-delete code path" is meant to hold even against 41's own governed mechanism (i.e., audit history is permanently exempt from retention). **This document does not resolve that tension or invent a retention period, an exemption, or an approved policy** — it is recorded as decision gate §5.12.

## 4. Control DB vs. Project DB vs. external-system ownership (summary)

| Domain | Control DB | Project DB | External (storage / queue / secrets) | Key unresolved ownership point |
| --- | --- | --- | --- | --- |
| Identity | Core user, credentials, tokens, external identity | None — explicit negative (13) | Profile image bytes; JWT signing keys (secret config) | Account-status enum representation (§3.1) |
| Session | Session/revocation record | None | JWT signing keys (secret config) | Revoke-all mechanism (§3.2) |
| Project | Registry, metadata, lifecycle, provisioning state | None until ready; then project-runtime data only (19 — Data model) | Cover image bytes (inferred) | Project↔Project-DB connection mapping (§3.3, gap) |
| Membership | All of it | **Explicit none** (15 — Data model) | — | Role/status enums **resolved** (§5.1/§5.2 — see [`control-database-role-decision.md`](control-database-role-decision.md)); unaffected gaps remain in §5.4 (who may create a project, unrelated) |
| Invitation | All of it | None | Email delivery via job platform | Expiry period value + storage location (§5.3, §3.5) |
| Draft | All of it (JSONB) | None — explicit negative (18) | — | Post-conversion disposition (§3.6, gap) |
| Job | Application metadata (generic case, 06/07) | None mentioned generically; **but** 39/40's export-specific audit event is Project DB (explicit for 40, inferred for 39) | pg-boss's own tables (co-located, not modeled here); result artifacts via storage (07, generic case only) | Queue engine itself remains undecided (PENDING-DECISIONS item 1) — not resolved here; **39/40 are an explicit, named exception with no job/storage footprint at all** — see §5.11, not resolved by assuming jobs are mandatory for every export |
| Audit | Control-plane `AuditEvent` + cross-project correlation | Project-resource `AuditEvent` + `OperationBatch`/`CompensatingAction` + export-specific audit records (39/40, Project DB) | 41's encrypted backup storage (implementation out of scope; requirements read) | Cross-project correlation mechanism (§5.9, gap); retention/anonymization is governed by 41 but its interaction with `AuditEvent`'s stated append-only/no-delete guarantee is unresolved (§5.12, gap) |

This table is a summary index only — §3's per-field rows are authoritative;
consult them before treating any cell here as a finalized decision.

## 5. Contradictions, missing information, and decision gates

Each item lists the conflicting sources, every affected consumer, the
precise question a decision must answer, and exactly what downstream schema
work it blocks. None of these is resolved by this document; recording them
does not authorize picking a side.

**5.1 — `PROJECT_OWNER` vs. `PROJECT_ADMIN` (role model). RESOLVED in
[03.03](../../../context/notion-tasks/sub-issues/03-03.md) — see
[`control-database-role-decision.md`](control-database-role-decision.md).**
Conflicting sources (unchanged, preserved for traceability):
[15 — Data model/Users and permissions](../../../context/notion-tasks/15-membership.md)
(five-value role enum headed by `PROJECT_ADMIN`, membership statuses
`ACTIVE`/`REMOVED` only) vs. [18 — Users and permissions/API behavior](../../../context/notion-tasks/18-protocol-wizard.md)
(a protected `PROJECT_OWNER`, a `PENDING_PROVISIONING` status, and a
backend-enforced correspondence to `Project.createdByUserId`); also named in
[21 — Users and permissions](../../../context/notion-tasks/21-project-settings.md)
(`PROJECT_OWNER` as the only General-settings-authorized role) and
[PENDING-DECISIONS item 2](../../../context/notion-tasks/PENDING-DECISIONS.md).
Affected consumers: 15, 16, 18, 19, 21, 22 (audit role-mapping), 23.
**Decision (user-approved):** `PROJECT_OWNER` replaces `PROJECT_ADMIN` as
the sole protected creator role — not an alias layered on top of it, and
not a sixth value added above it. See the decision record's §3.1/§4 for the
full textual evidence (15's own prose already uses "Project Owner" and
"Project Admin" interchangeably) and rejected alternatives. This closes the
`Membership.role` enum question and the membership-status enum question
(three values: `PENDING_PROVISIONING`, `ACTIVE`, `REMOVED`) for 03.04.

**5.2 — Last Project Manager vs. last Project Admin guard. RESOLVED in
[03.03](../../../context/notion-tasks/sub-issues/03-03.md) — see
[`control-database-role-decision.md`](control-database-role-decision.md)
§3.2.** Conflicting sources (unchanged, preserved for traceability): both
**within guide 15 itself** — Acceptance criteria ("Removing the last
Project Admin is rejected") vs. API behavior ("does not violate the
last-Project-Manager guard"); also [PENDING-DECISIONS item 2](../../../context/notion-tasks/PENDING-DECISIONS.md).
Affected consumers: 15 only. **Decision (user-approved):** the Owner's
protection is absolute and not count-based (no "last member" check is
needed for the Owner — it simply can never be removed); there is **no**
Manager-count floor — removing the last Project Manager is explicitly
allowed. The "last-Project-Manager guard" phrase in 15's API behavior is
rejected as a real, independent rule going forward.

**5.3 — Invitation expiry: 7 days vs. 48 hours.** Conflicting sources: 15 —
UI/API behavior (7-day default, admin-configurable) vs. 15 — Jobs behavior
(48 hours); [PENDING-DECISIONS item 3](../../../context/notion-tasks/PENDING-DECISIONS.md).
Affected consumers: 15 (token generation, UI display, scheduled cleanup); 23
(if the value is meant to be admin-configurable, its storage key is also
undefined — see §3.5). Precise question: is the default 7 days (configurable)
or a fixed 48 hours, and is it configurable at all? Blocks: `Invitation`'s
expiry default/validation and the scheduled-cleanup job's cutoff logic.

**5.4 — Who may create a project.** Conflicting sources: 19 — Behavior ("any
authenticated user can start a project-creation draft") vs. 18 — Users and
permissions ("users with project-creation permission can start... a draft");
[PENDING-DECISIONS item 6](../../../context/notion-tasks/PENDING-DECISIONS.md).
Affected consumers: 18, 19. Precise question: is draft/project creation open
to every authenticated user, or gated by a permission/role that no source
names explicitly? Blocks: whether `Draft` creation needs an authorization
check against a field that does not yet exist anywhere in this inventory (a
"can-create-projects" flag/role has no source-named representation).

**5.5 — Project ownership/administration access matrix. RESOLVED in
[03.03](../../../context/notion-tasks/sub-issues/03-03.md) — see
[`control-database-role-decision.md`](control-database-role-decision.md)
§3.4/§5.** Conflicting sources (unchanged, preserved for traceability): 19 —
Gaps (creator-plus-Application-Administrator access alternates with
owner-only editing — resolved by noting the creator *is* the Owner, so these
were never actually different grantees) and 21 — Gaps (Owner-only per
Users/permissions vs. Project-Manager-inclusive per UI behavior's "Access
rules"); [PENDING-DECISIONS items 6 and 11](../../../context/notion-tasks/PENDING-DECISIONS.md)
(item 6 remains open for the unrelated "who may create a project" question —
see §5.4 above; only item 11's settings-access half is closed here).
Affected consumers: 19, 21. **Decision (user-approved):** `PROJECT_OWNER`
and Application Administrator only, for every action named in 19 (project
metadata edit, publish/unpublish, archive/restore) and every Settings tab in
21 (General, Screening, QA, Data Extraction, Reporting) — Project Manager
has none of this access, in any tab. This explicitly overrides 21's own
looser UI-behavior "Access rules" paragraph; see the decision record's §5
for the full permission matrix. Authorization remains a pure API-boundary
role check — no "settings access grant" schema element is introduced.

**5.6 — Direct settings vs. a protocol-revision/activation job (guide 21's
own self-contradiction).** Conflicting sources, all within 21: Description/
most of UI behavior/API behavior/Acceptance-criteria-prose (no
revision/version-comparison/activation/rollback UI) vs. 21 — Jobs behavior
(describes an "idempotent revision job," "persist validation, impact,
progress, and failure reports for the revision," and "duplicate protocol
versions"); [PENDING-DECISIONS item 11](../../../context/notion-tasks/PENDING-DECISIONS.md).
Affected consumers: 21, 23 (which explicitly warns its own labels/settings
revision model "must not reintroduce protocol revisions prohibited in
[21]"). Precise question: does Project Settings ever need any
version/revision/activation data model, or is it strictly direct-editing
with only `createdBy`/`createdAt`/`modifiedBy` columns and no history beyond
that? Blocks: whether any Project DB protocol table needs version/revision
columns at all — directly relevant to this sub-issue's instruction not to
introduce drafts/revisions where a consuming task prohibits them, since 21
prohibits them in its majority text while its own Jobs behavior field
contradicts that.

**5.7 — Project DB connection-mapping storage (missing information, not a
conflict).** No source states this. [17 — Data model](../../../context/notion-tasks/17-project-resolver.md)
is entirely empty ("Data model: Empty"); [16 — Data model](../../../context/notion-tasks/16-project-template.md)
lists provisioning metadata but no explicit "physical database
identifier/connection reference" field, even though 16 — API behavior is
explicit that this value must never be exposed to a client. Affected
consumers: 16, 17. Precise question: where and in what form is the mapping
from `projectId` to its physical, ready Project DB persisted? Blocks: the
resolver's schema cannot be designed in 03.04 without this; recommend
obtaining a decision (or an explicit "to be designed in 03.04 without a
source answer, flagged as an engineering decision") before finalizing the
Control DB project-registry table.

**5.8 — Invitation-validity-period storage location (missing information).**
15 — UI behavior names an Application-Administrator-configured value; 23 —
Data model only describes a generic, keyless "typed global settings"
registry. Affected consumers: 15, 23. Precise question: is this a
`SystemSetting` row (keyed how?), a dedicated Control DB column on some
other table, or a literal constant? Blocks: `Invitation.expirationTime`'s
computation — low severity, since a literal default can stand in once 5.3 is
resolved, but the configurability requirement itself remains unimplemented
until this is answered.

**5.9 — Cross-project audit correlation mechanism (missing information).**
22 — Data model names "cross-project operation correlation metadata" in the
Control DB without defining its shape, while the actual `OperationBatch`/
`CompensatingAction` records live per-project. Affected consumers: 22.
Precise question: what exact Control DB record lets an Application
Administrator search/filter operation history across every Project DB
without fanning out to each one at query time? Blocks: the `AuditEvent`/
correlation schema design in 03.04 — this is a real architectural question,
not merely a field-naming one.

**5.10 — Draft-to-Project conversion disposition (missing information).** No
source (18's Data model/API behavior, or 19) states what happens to a
`Draft` row after its wizard confirmation successfully creates a `Project`.
Affected consumers: 18, 19 (which shows *unfinished* drafts in "My projects"
but never addresses finished ones). Precise question: is the Draft row
deleted, archived, or retained and linked to the resulting Project for
history? Blocks: `Draft` entity lifecycle/retention design in 03.04.

**5.11 — Job/storage-backed exports (06/07) vs. direct-streaming exports
(39/40).** Conflicting sources: [06 — job platform](../../../context/notion-tasks/06-job-platform.md)/
[07 — storage](../../../context/notion-tasks/07-storage.md) describe a
generic job-backed, potentially persisted export model, while [39 — Gaps](../../../context/notion-tasks/39-csv-bibtex-exports.md)
states plainly: *"This task's 'no job/no persistence' contract also
conflicts with the generic jobs/storage platform's expectation of persisted
exports (06/07) — follow this ticket's specific direct-streaming contract,
not the generic one"*; [40](../../../context/notion-tasks/40-python-r-exports.md)
states the same no-job/no-persistence contract independently. A **second,
separate** conflict on the same two guides: 39 — Users and permissions says
"every application user" can generate an export, directly contradicted by
39's own API behavior's project/export-authorization requirement;
[PENDING-DECISIONS item 14](../../../context/notion-tasks/PENDING-DECISIONS.md)
records both. Affected consumers: 06, 07, 39, 40. Precise questions: (a)
should every future export feature default to the generic job/storage model
unless a guide states otherwise (as 39/40 already do), or is there a broader
exemption criterion not yet named? (b) exactly who may trigger a CSV/BibTeX
export — all project members, Guests, or an authorized public audience for
a Published project? Blocks: whether any export-related schema element
belongs in the Job/storage domain (§3.7) at all for a given export feature —
**this document does not make jobs mandatory for every export**; 39/40's
explicit no-job rows in §3.7 stand as named exceptions, not as a general
rule for exports not yet specified.

**5.12 — `AuditEvent` append-only guarantee vs. 41's retention/anonymization
mechanism.** Conflicting sources: 22 — Definition of Done ("`AuditEvent`
records are append-only at the data-access layer — there is no update or
hard-delete code path for them anywhere in the codebase") and 22 — UI
behavior ("Never provide a UI action to erase audit history. Retention or
anonymization is handled through the dedicated hardening policy [41]") vs.
[41 — Data model/Acceptance criteria](../../../context/notion-tasks/41-backup-hardening.md)
(versioned retention/anonymization policies, executed through
`executeRetentionAction`, covering unnamed "categories" of data). Affected
consumers: 22, 41, and — if 41's retention scope is ever extended to audit
data — 03.04's `AuditEvent` schema itself. Precise question: is `AuditEvent`
permanently exempt from any future 41-driven retention/anonymization action
(making 22's "no update or hard-delete code path" an unconditional,
permanent guarantee), or does 41's eventual retention mechanism include
audit history as one of its governed "categories" (in which case 22's
absolute wording would need a narrower reading — "no *ad hoc* update/delete
path outside the governed retention mechanism")? Blocks: whether 03.04's
`AuditEvent` model needs any retention-policy linkage field at all. **This
document does not invent a retention period, an exemption, or an approved
policy for either side** — implementing 41 remains out of scope regardless
of how this question is eventually answered.

Of these twelve items, **§5.1, §5.2, and §5.5 are now RESOLVED** per
[03.03's decision record](control-database-role-decision.md); the remaining
nine (§5.3, §5.4, §5.6–§5.12) are still open. Documenting all twelve does
not block the rest of this inventory — every other field in §3 that is not
cited above is unaffected and could already proceed to 03.04 design before
03.03 landed, and the three now-resolved gates no longer block anything in
03.04.

## 6. Planned verification scenarios (NOT executed — proposals for 03.04/03.05)

These are derived directly from the constraints recorded in §3 and are
explicitly **not** automated tests, not run, and not evidence of any
behavior today — they are a forward-looking checklist for whoever implements
and tests the eventual schema/repositories.

- **Identity:** duplicate normalized username/email rejected at the data
  layer; archiving the last active Application Administrator rejected;
  archived user cannot authenticate; email-verification token is single-use
  and a second request invalidates the first; password-reset token same;
  Google `ExternalIdentity` lookup by `(provider, sub)` never matches by
  email alone.
- **Session:** a revoked session is rejected even with a non-expired,
  signature-valid token; a password change/reset invalidates every other
  active session for that account, not only the current one.
- **Project:** project short-name uniqueness enforced at the data layer
  (not only client-side); repeating the same provisioning idempotency key
  does not create a second project/database/membership; mutating project
  metadata (title, description, research questions) succeeds only for
  `PROJECT_OWNER` and Application Administrator and is rejected for every
  other role, including Project Manager — per the resolved decision in
  [`control-database-role-decision.md`](control-database-role-decision.md)
  §3.4/§5 (closing former gate §5.5); an archived project rejects writes at
  the API layer.
- **Membership:** at most one active membership per `(projectId, userId)`
  enforced at the data layer; removing or role-changing the `PROJECT_OWNER`
  membership is rejected unconditionally — by the Owner themself, by a
  Project Manager, or by an Application Administrator — with no "last
  member" counting involved (role-decision §3.2/§9); removing the **last
  Project Manager** in a project **succeeds** (the rejected "require at
  least one Manager" alternative must not be silently implemented anyway);
  removing a membership never deletes the underlying User row.
- **Invitation:** at most one active invitation per `(projectId,
  normalizedEmail)` enforced at the data layer; resending invalidates the
  prior token; an expired invitation cannot be accepted; accepting requires
  verified ownership of the invited email and never silently changes the
  stored role.
- **Draft:** a draft is resumable only by its creator or an audited
  Application Administrator; a draft alone never creates a Project DB
  connection or row; final confirmation with a repeated idempotency key
  returns the existing result rather than duplicating anything.
- **Job:** enqueuing the same idempotency key twice does not create a
  second job; `listJobs` never leaks another project's jobs to a Project
  Admin; a job payload never contains a credential-shaped value; a CSV/
  BibTeX or Python/R export (39/40) completes with **no** job, worker, or
  retained artifact of any kind — these two export features are the named
  exception to every job-related scenario above, not an oversight to be
  "fixed" by adding a job to them (§5.11).
- **Audit:** no code path updates or hard-deletes an `AuditEvent` in either
  database; a control-plane mutation is recorded as a control-plane
  `AuditEvent` and a project-resource mutation is recorded as a
  project-resource `AuditEvent` in that project's own database — routed by
  the mutation's own scope, not written to both by default; whether (and
  how) a project-scoped action additionally needs a correlating Control DB
  entry so an Application Administrator can search across projects is the
  open design question recorded in §5.9, **not** an established dual-write
  requirement to test for; a `CompensatingAction` preview that said "safe"
  is re-validated (and can still be rejected) at execution time if state
  changed in between.

## 7. Handoff checklist for 03.03, 03.04, and 03.05

- [x] **03.03's four scoped decisions are approved.** §5.1
      (`PROJECT_OWNER`/`PROJECT_ADMIN`), §5.2 (last-protected-member guard),
      the settings/metadata half of §5.5, and the ownership-transfer
      question are resolved and user-approved in
      [`control-database-role-decision.md`](control-database-role-decision.md).
      03.04 can now finalize the `Membership.role` enum
      (`PROJECT_OWNER, PROJECT_MANAGER, REVIEWER, VALIDATOR, GUEST`) and
      `Membership.status` enum (`PENDING_PROVISIONING, ACTIVE, REMOVED`)
      against that record rather than guessing. §5.4 (who may create a
      project) remains open and is **not** addressed by 03.03 — it is a
      separate question about draft/project creation, not role
      representation.
- [x] **Owner-account archival gap (role-decision §3.5) — carried forward,
      not blocking 03.03.** Correcting 03.03's decision record surfaced an
      unresolved interaction: membership protection does not guarantee the
      Owner's underlying `User` account stays active/authenticatable, and
      no source states what should happen if it is archived. This is
      **not** one of 03.03's four approved decisions and remains
      explicitly **unresolved**, not approved — the user confirmed it
      should be carried forward as a reported open gap rather than
      resolved before 03.03 closes (see role-decision.md §3.5/§8). It
      blocks only 13's future `archive-user` authorization design, not
      this sub-issue's completion.
- [ ] **03.04** (schema/migrations/client) should treat §3's **explicit**
      rows as the primary input, **inference** rows as needing an explicit
      note in the schema/PR description (not silent adoption), and must
      obtain a decision — or record an explicit, reported engineering
      choice — for every **unspecified**/gap item in §5 before encoding it,
      per this task's "do not silently treat an unresolved requirement as
      settled" instruction. §5.7 (Project DB connection mapping) and §5.9
      (cross-project audit correlation) are the two gaps most likely to
      require real architectural design work, not just a field name.
- [ ] **03.04** must keep the Control DB / Project DB / External boundaries
      in §4 intact: no membership/identity/session data in any Project DB
      (15's explicit negative); no protocol/settings data duplicated into
      the Control DB beyond the specific fields §3.3/§3.6 name (project
      metadata + research-question order only); `AuditEvent` modeled
      separately per database, never as one shared table; pg-boss's own
      tables left alone — only the companion job-metadata model from §3.7
      is this inventory's concern.
- [ ] **03.05** (typed repositories) should expose repository boundaries
      aligned to §3's eight domains rather than one generic data-access
      surface — e.g. a membership repository must not also expose raw
      invitation-token or credential operations, consistent with the parent
      card's "do not expose generic CRUD" requirement.
- [ ] **03.04** must preserve 39/40's explicit no-job/no-persistence contract
      for CSV/BibTeX and Python/R exports as a named exception to 06/07's
      generic job-backed export model — do not add a job, retention, or
      artifact table to those two export types on the assumption that every
      export must be job-backed; see §5.11. The export-specific audit
      record (39's export audit event; 40's `ReportingExportAudit`) is also
      a distinct model from the general `AuditEvent` in §3.8 — do not merge
      them.
- [ ] **03.04** must not treat 41's eventual retention/anonymization
      mechanism as license to add an update/hard-delete code path to
      `AuditEvent` now — §5.12's reconciliation between `AuditEvent`'s
      stated append-only guarantee and 41's governed retention mechanism
      remains open. Implementing any part of 41 (backup/restore, encrypted
      artifact storage, retention-policy UI) stays out of scope for
      03.02–03.05 regardless of how §5.12 is eventually answered.
- [ ] Any schema element introduced in 03.04 that cannot be traced to a row
      in §3, or to a decision recorded in §5, should be treated as scope
      expansion requiring its own justification — this inventory is meant to
      make that check straightforward.

## Acceptance-criteria evidence (for this sub-issue, 03.02)

- **Every listed field/relation has a source or an explicit inference/decision
  label:** every row in §3's eight tables carries a Status column value
  (explicit / inference / conflicting / unspecified) and a Source column
  citing the exact guide and section it was reproduced from.
- **All eight requested domains are accounted for, including explicit
  "unspecified" findings:** §3.1–§3.8 cover identity, session, project,
  membership, invitation, draft, job, and audit in order; each contains at
  least one row explicitly labeled "unspecified" or flagged as a gap where
  the sources leave a representation undefined (e.g. §3.1's account-status
  enum, §3.3's connection-mapping gap, §3.6's draft-disposition gap, §3.8's
  correlation-mechanism gap, §3.7's export-audit ownership inference).
- **Undefined role and ownership semantics are flagged before constraints
  are proposed:** as originally written for 03.02, §5.1/§5.2 recorded the
  `PROJECT_OWNER`/`PROJECT_ADMIN` and last-protected-member conflicts without
  proposing a resolution, and §3.4's role-enum row was marked "conflicting"
  rather than defaulting to either source's version — satisfying this
  sub-issue's own AC at the time. **Update:** 03.03 has since resolved §5.1,
  §5.2, and the settings/metadata half of §5.5 with explicit user approval
  (see [`control-database-role-decision.md`](control-database-role-decision.md));
  §3.3/§3.4 and §6 above have been updated accordingly, and this remains
  consistent with "flag before proposing constraints," since the flag came
  first and the resolution was obtained, not assumed.
- **No business schema or repository implementation is introduced:** this
  document contains no Prisma syntax, no TypeScript interface, and no code
  change; §2 confirms `@relis/contracts` and `@relis/database` are unchanged
  from the 03.01 baseline; the 41 cross-reference after §3.8 explicitly
  disclaims any backup/restore schema design.
- **No unresolved requirement is silently treated as settled:** §5's twelve
  items (including the two added by this correction — §5.11 direct-export
  exceptions, §5.12 audit-retention reconciliation) are each phrased as an
  open question with affected consumers and blocked downstream work, not as
  a chosen interpretation; §6's scenarios are explicitly labeled "NOT
  executed" and no longer assert the unconditional project-metadata or
  dual-audit-write claims corrected by this update.
