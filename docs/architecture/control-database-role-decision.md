# Project role/ownership decision — `PROJECT_OWNER` vs. `PROJECT_ADMIN`

Local sub-issue: [03.03 — Resolve the PROJECT_OWNER/PROJECT_ADMIN discrepancy
before finalizing identity and membership enums and
constraints](../../../context/notion-tasks/sub-issues/03-03.md), under parent
[03 — Create control Prisma schema](../../../context/notion-tasks/03-control-prisma.md).

No `docs/adr/` convention exists in this checkout (confirmed empty/absent
before writing this file), so this record uses the fallback location named
by the sub-issue's own instructions.

## 1. Status and approval

**Status: Decided**, for exactly four items; **one additional gap (§3.5) is
explicitly NOT decided** and is recorded, not approved, below. The four
decided items in §3.1–§3.4 each carry explicit user approval in this
session: for each, a structured question (`AskUserQuestion`) presented the
sourced analysis and a small set of labeled alternatives, one marked
"Recommended," and the user's recorded answer selected that exact labeled
option for all four questions — including the Settings/metadata split in
§3.4, where the user's answer was literally "Owner + App Admin only,
everywhere (Recommended)," re-verified against this session's own
transcript while making the corrections below. No decision in this record
is a Claude recommendation standing alone — every one of the four carries
that explicit selection. §3.5 carries no such selection and must not be
read as approved.

This decision is scoped **narrowly** to the `PROJECT_OWNER`/`PROJECT_ADMIN`
representation, the associated protected-member rule, ownership-transfer
support (bounded to the current scope — see §3.3), and the Settings/metadata
permission split named by this sub-issue's own question list. It does
**not** resolve every open item in [`control-database-contracts.md`](control-database-contracts.md)'s
§5, and it surfaced one new, unresolved gap of its own (§3.5) — see §8 for
exactly which gates this decision does and does not close.

## 2. Source conflicts (traced, not re-litigated)

Full citations already exist in [`control-database-contracts.md`](control-database-contracts.md)
§5.1/§5.2/§5.5 and [`PENDING-DECISIONS.md`](../../../context/notion-tasks/PENDING-DECISIONS.md)
item 2; this section adds the specific textual evidence that shaped the
selected interpretation, re-verified against the guides during this
sub-issue:

- **15 already conflates "Owner" and "Admin" in its own prose**, before 18
  enters the picture. 15 — Users and permissions reads, in sequence: *"The
  creator becomes Project Owner when project creation succeeds."* → *"A
  Project Admin and Project Manager can add, invite, change the role of, and
  remove users..."* → *"A Project Owner/Manager can assign: Project Manager,
  Reviewer, Validator, or Guest."* `PROJECT_ADMIN` never appears in that
  assignable list — only Manager/Reviewer/Validator/Guest do. This is
  internal evidence that 15's own author already treated "Project Owner"
  and "Project Admin" as one concept under two labels.
- **16 — Users and permissions** adds a third label for the same
  initial-creator-membership concept: *"The creator receives a **pending
  Project Manager** membership in the Control DB."*
- **18 — API behavior** formalizes `PROJECT_OWNER` with protection semantics
  15 never had: *"assigned automatically to the creator; cannot be
  assigned/removed/changed by membership-management endpoints; the backend
  enforces it corresponds to `Project.createdByUserId`"*, plus a
  `PENDING_PROVISIONING` membership lifecycle state.
- **21 — Users and permissions** uses `PROJECT_OWNER` as a literal
  access-control value (*"Only `PROJECT_OWNER` can access `/settings`"*),
  structurally identical to how 15 would check a role — then 21's own UI
  behavior "Access rules" paragraph contradicts that same sentence by also
  granting Project Manager four of the five Settings tabs.
- **22** only ever says "Project Admin" for project-scoped audit/undo
  access, never "Owner," and its own Gaps section flags that "Project Admin
  and Owner require an approved mapping."
- **15's last-protected-member guard is internally split**: Acceptance
  criteria says "Removing the last Project Admin is rejected"; API behavior
  says the add-member flow checks "the last-Project-Manager guard."
- **19 vs. 21** disagree on whether Project Manager ever gets
  project-administration access beyond ordinary project-scoped work
  (`PENDING-DECISIONS` items 6 and 11).

## 3. Decisions (each user-approved)

### 3.1 Owner representation — **Owner replaces Admin**

`PROJECT_OWNER` is the sole protected, creator-bound top-tier project role.
15's `PROJECT_ADMIN` enum value is renamed to `PROJECT_OWNER` — it is not a
second, separate senior role. `PROJECT_MANAGER` remains the highest
*ordinary* (assignable, removable) role below it.

**Canonical role enum:** `PROJECT_OWNER, PROJECT_MANAGER, REVIEWER,
VALIDATOR, GUEST` (five values — same count as 15's original list, with
`PROJECT_ADMIN` renamed, not a value added).

*Rejected alternatives* (presented, not chosen):
- *Owner above Admin* — would add `PROJECT_OWNER` as a 6th value sitting
  above an unchanged `PROJECT_ADMIN`. Rejected because no source describes a
  delegated "Admin" ever assigned to anyone other than the creator; this
  would manufacture a role with no described assignment path.
- *Owner as a derived attribute, not a role* — would keep 15's five-value
  enum untouched and represent ownership only via `Project.createdByUserId`
  plus a flag. Rejected because 18/21 use `PROJECT_OWNER` as a literal
  role-gating value with its own membership lifecycle state
  (`PENDING_PROVISIONING`), which a plain derived attribute would not need.

### 3.2 Last-protected-member guard — **no Manager-count guard**

Only the Owner is permanently protected, and that protection is absolute,
not count-based: the Owner membership can **never** be removed or
role-changed through any membership-management endpoint, regardless of how
many other members exist (see §5). There is **no** "at least one Manager
must remain" rule — Project Managers (and every other non-Owner role) can
be removed down to zero; the Owner alone can always re-add one.

This supersedes both halves of 15's internal conflict: "last Project Admin"
(Acceptance criteria) is read as describing the Owner's now-absolute
protection; "last-Project-Manager guard" (API behavior) is explicitly
**rejected** as a real, independent invariant — 15's own text at that
specific point should be read as superseded by this decision, not as a
requirement still pending implementation.

*Rejected alternative:* requiring at least one Project Manager at all
times. Rejected because no use case in any read guide depends on a Manager
always being present, and adding a quantity-based guard for Manager alone
would introduce a validation rule no source actually needs. This guard
removal is about membership-level counting only — it is **not** a claim
that the Owner's protection guarantees a project is always administrable by
someone with an active, usable account: see §3.5 for the separate,
unresolved question of what happens when the Owner's *User* account itself
is archived.

### 3.3 Ownership transfer — **unsupported in the current scope**

`Project.createdByUserId` remains the immutable creation-attribution fact —
set once at project creation, never accepted from the client (18, 19). In
the current model, the project's `PROJECT_OWNER` membership corresponds to
that same creator: no use case, endpoint, or schema relation in any read
guide supports reassigning it to a different user, and none is introduced
by this decision.

This is the explicit "unsupported in current scope" answer this
sub-issue's own instructions permit — a scoping decision for the schema
work 03.04/03.05 are about to do, **not** a permanent architectural
prohibition asserting ownership can never change under any future decision.
**If a future guide or product decision introduces an ownership-transfer
feature, that requires its own explicit approval and a separate
schema/migration review** — this document neither precludes that nor
speculatively designs for it now (no reassignable-owner relation, no
transfer audit table, no transfer workflow is introduced here).

*Rejected alternatives (for the current scope only):* designing a separate,
reassignable owner relation "for later," or leaving the question open for
this sub-issue. Both rejected because no source guide describes a transfer
feature today, and per [`AGENTS.md`](../../AGENTS.md)'s working agreement,
this repository does not design for hypothetical future requirements that
no approved specification names — that reasoning bounds *this sub-issue's*
scope; it does not foreclose a future, separately-approved feature.

### 3.4 Settings/metadata permission split — **Owner + Application Administrator only, everywhere**

For every action named in 19 (project metadata: title/description/research
questions edit, publish/unpublish, archive/restore) and every Settings tab
in 21 (General, Screening, Quality Assessment, Data Extraction, Reporting):
only `PROJECT_OWNER` and Application Administrator have access. Project
Manager has **none** of this access, in any tab.

This selects 19's and 21's own stricter "Users and permissions" wording
literally, and **explicitly overrides** 21's own looser UI-behavior "Access
rules" paragraph, which had granted Project Manager four of the five
Settings tabs. When 21 is eventually implemented, that specific UI-behavior
sentence must be treated as superseded by this decision, not implemented as
written.

*Rejected alternative:* granting Project Manager delegated access to
Screening/QA/Data-extraction/Reporting settings (21's own UI-behavior
reading). Rejected in favor of the stricter, internally consistent reading
shared by 19 and 21's "Users and permissions" sections, rather than 21's
self-contradicting UI-behavior text.

### 3.5 Owner-account archival — **NOT decided; recorded gap, not a decision**

Membership protection (§3.2: the `PROJECT_OWNER` membership row can never
be removed/role-changed) is a statement about the `Membership` row. It is
**not** a guarantee that the `User` account behind that row remains active
or authenticatable. Guide 13 — the only source read for this sub-issue that
addresses account archival — was inspected specifically for this
interaction, with the following result:

- 13 protects exactly one thing from archival: *"Application Administrators
  cannot archive the final active Application Administrator account"* (13 —
  Users and permissions/Acceptance criteria). This is a **global**
  authority protection, unrelated to any project-level role.
- 13 says nothing about archiving a user who currently holds a
  `PROJECT_OWNER` membership in one or more projects. No exception, no
  additional confirmation step, and no cross-check against project
  ownership is described anywhere in 13 (or in 15/16/18/19/21/22) for that
  case.
- No source describes an automatic ownership transfer, reassignment, or
  any other remediation triggered by archiving a project-owning user.
- No source grants Application Administrator (or anyone else) an override
  path to reassign or bypass a `PROJECT_OWNER` membership specifically
  *because* its user was archived — this would itself be a transfer
  mechanism, which §3.3 already records as unsupported in the current
  scope.

**The gap, stated precisely:** nothing read for this sub-issue prevents an
Application Administrator from archiving a user who owns one or more active
projects (13's own archive-user flow has no stated exception for this).
Once archived, per 13's existing rule that archived users "cannot log in,"
that project's `PROJECT_OWNER` membership would point to a user who can no
longer authenticate — and per §3.2/§3.3, nothing can reassign or remove
that membership to fix it. This document does **not** assume any of the
following, because none is stated by any source: that archival must be
blocked when the target owns a project; that ownership transfers
automatically on archival; or that Application Administrators gain an
implicit override to resolve the resulting state. All three remain
undecided.

**Downstream behavior blocked pending a decision:** 03.04 cannot decide
whether `archive-user` (13) needs a project-ownership check or guard at
all, and 03.05's membership/user repositories cannot know whether such a
check belongs in their validation logic. Until this is decided, the
honest, source-supported behavior is: archiving a project-owning user is
**allowed**, and the resulting project is left with a non-reassignable,
unauthenticatable Owner indefinitely (the project's Settings/metadata
actions remain reachable only via Application Administrator per §3.4,
since Manager has no access to them either) — this is a real operational
gap, not a resolved design choice.

This is a genuinely new gap surfaced while completing 03.03, not one of
the seven questions this sub-issue's own instructions listed, and not one
the four approved decisions in §3.1–§3.4 resolve. **The user was asked
whether resolving it is required to close 03.03, and confirmed it should
instead be carried forward as an explicitly reported open gap** — this
gap does not block 03.03's own completion; it blocks only the specific
downstream work named in §8 (13's `archive-user` authorization logic) once
that work is actually undertaken.

## 4. Canonical terminology — mapping from every conflicting source label

| Source label (as written) | Where it appears | Canonical meaning after this decision |
| --- | --- | --- |
| `PROJECT_ADMIN` (role enum) | 15 — Data model | Renamed to `PROJECT_OWNER` |
| "Project Owner" (prose) | 15 — Users and permissions | `PROJECT_OWNER` (unchanged meaning, now also the enum value) |
| "pending Project Manager membership" (for the creator) | 16 — Users and permissions | The creator's initial membership is `PROJECT_OWNER` with status `PENDING_PROVISIONING` — **not** `PROJECT_MANAGER`. 16's label is superseded by 18's more detailed, later-formalized contract. |
| `PROJECT_OWNER` | 18 — API behavior; 21 — Users and permissions | Canonical, unchanged |
| "Project Admin" (in an audit/undo context) | 22 — Users and permissions | `PROJECT_OWNER` |
| "last Project Admin" (guard) | 15 — Acceptance criteria | The Owner's unconditional, non-count-based protection (§3.2) |
| "last-Project-Manager guard" | 15 — API behavior | **Rejected** — no such guard exists (§3.2) |
| "Project Manager... Screening/QA/Extraction/Reporting access" | 21 — UI behavior ("Access rules") | **Superseded** — Manager has no Settings access of any kind (§3.4) |

## 5. Permission matrix (limited to the actions examined by this decision)

Legend: ✅ allowed · ❌ forbidden · n/a not applicable to that role.
Application Administrator rows assume its existing "audited global access"
(13, 15) — every ✅ for Application Administrator is an **audited** action,
per the sources already cited in `control-database-contracts.md` §3.1/§3.8.

| Action | Owner | Manager | Reviewer | Validator | Guest | App Admin |
| --- | --- | --- | --- | --- | --- | --- |
| Add/invite a member (assign Manager/Reviewer/Validator/Guest) | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ (any project) |
| Assign the `PROJECT_OWNER` role to anyone | ❌ (no such action exists) | ❌ | ❌ | ❌ | ❌ | ❌ (no such action exists — §3.3) |
| Change another member's role (to Manager/Reviewer/Validator/Guest) | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ |
| Remove a member (Manager/Reviewer/Validator/Guest) | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ |
| Remove or role-change the `PROJECT_OWNER` membership | ❌ (not even by itself) | ❌ | ❌ | ❌ | ❌ | ❌ (no path exists — §3.3) |
| View Team page (active members + invitations) | ✅ | ✅ | *unspecified — see §8* | *unspecified — see §8* | *unspecified — see §8* | ✅ |
| Open workspace (any active member) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (audited) |
| Edit project metadata / publish/unpublish / archive/restore (19) | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| General settings tab (21) | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Screening / QA / Data-extraction / Reporting settings tabs (21) | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| View project audit events / undo centre, own project (22) | ✅ | ❌ (no delegated grant mechanism designed here) | ❌ | ❌ | ❌ | ✅ (any project) |

Rows marked "unspecified" are **not** decided by this sub-issue — they were
not among the seven questions this sub-issue's own instructions listed, and
no source states them either way. They are carried forward as an open,
low-severity gap in §8, not silently defaulted.

## 6. Creator/owner invariants, protected-member rules, membership lifecycle

- **Exactly one `PROJECT_OWNER` membership per project, always.** Created in
  the same Control DB transaction as the `Project` row itself (18 — API
  behavior), so a project is never without one and never has more than one.
- **`Project.createdByUserId` is immutable**, set once at creation, never
  accepted from the client (18, 19).
- **Structural correspondence**: the `PROJECT_OWNER` membership's `userId`
  for a given project equals that project's `createdByUserId`, in the
  current model — a standing invariant **for as long as no ownership-transfer
  feature is separately approved and implemented** (§3.3); it is not merely
  true at creation time, since no path exists today to reassign it.
- **Membership status enum**: `PENDING_PROVISIONING, ACTIVE, REMOVED`.
  `PENDING_PROVISIONING` applies only to the Owner's membership, only
  between project-creation and the moment the Project DB is ready **and**
  protocol `v1` is persisted (18 — API behavior); every other membership
  (added via Team, or via invitation acceptance) is created directly
  `ACTIVE` (15 — API behavior).
- **The Owner `Membership` row never reaches `REMOVED`** through any
  membership-management endpoint, by anyone, including Application
  Administrator (§3.3 — no reassignment/removal path was ever described).
  Archiving a *project* (19) is a separate, `Project`-level state change and
  does not remove the Owner's membership row. **This governs the
  `Membership` row only** — it says nothing about whether the Owner's
  underlying `User` account remains active/authenticatable; that is a
  separate, explicitly unresolved question (§3.5).
- **Every other role's membership can reach `REMOVED` with no count floor**
  (§3.2) — a project may validly have zero Managers, zero Reviewers, etc.,
  at any time; only the Owner's **membership row** is guaranteed to exist —
  not that a usable, active `User` account stands behind it (§3.5).
- **Manager cannot remove or role-change the Owner** — now a redundant
  restatement of the absolute rule above, since *nobody* can, not a
  Manager-specific restriction.

## 7. Effects on future schema constraints vs. authorization/use-case logic

This decision does not implement anything (03.04/03.05's job) and does
**not** choose an exact constraint, index, trigger, or application
mechanism — all of that remains 03.04's design choice. It separates the
rules above into three kinds, so 03.04 knows which are even candidates for
database-level enforcement and which are not. Prisma's declarative schema
language having a limitation is **not** the same as PostgreSQL itself
having that limitation — category B below exists specifically because of
that distinction.

**A. Plain, Prisma-declarable database constraints:**
- `Membership.role` enum includes `PROJECT_OWNER` (replacing
  `PROJECT_ADMIN`), `PROJECT_MANAGER`, `REVIEWER`, `VALIDATOR`, `GUEST`.
- `Membership.status` enum includes `PENDING_PROVISIONING`, `ACTIVE`,
  `REMOVED`.
- The existing `(projectId, userId)` active-membership uniqueness
  (unchanged from `control-database-contracts.md` §3.4).
- A per-project uniqueness constraint for the `PROJECT_OWNER` row (e.g. a
  partial/filtered unique index on `projectId` where
  `role = 'PROJECT_OWNER'`) — straightforward for PostgreSQL to enforce,
  though depending on Prisma's version it may need a raw-SQL migration step
  rather than a bare declarative `@@unique` attribute; that detail is
  03.04's to resolve, not fixed here.

**B. Structural invariants not expressible as a simple Prisma-declarative
constraint, but not necessarily application-only either — PostgreSQL
itself can enforce these (e.g. via a trigger or function) if 03.04 chooses
to add one. This document flags the invariant and the option; it does not
choose the mechanism:**
- The `PROJECT_OWNER` membership's `userId` equals `Project.createdByUserId`.
  Prisma's schema language cannot express "this foreign key's target equals
  a sibling table's column" declaratively, but PostgreSQL can — e.g. a
  `BEFORE INSERT`/`BEFORE UPDATE` trigger or a check function. Whether
  03.04 adds such a trigger, or enforces this purely in application code at
  creation time (never mutated afterward), is not decided here.
- "The `PROJECT_OWNER` membership can never be removed or role-changed via
  membership-management endpoints" — a PostgreSQL trigger *could* reject
  such an `UPDATE`/`DELETE` at the database layer as defense-in-depth,
  regardless of which code path attempts it. Whether 03.04 adds that
  reinforcement is not decided here; application-layer rejection is
  required either way, since a bare database trigger cannot by itself
  distinguish "an authorized workflow transitioning
  `PENDING_PROVISIONING` → `ACTIVE`" from "an unauthorized removal
  attempt" without encoding that workflow logic into the trigger itself.

**C. Endpoint authorization and transactional workflow rules — not
database constraints under any implementation, because they depend on
*who is calling* or *where in a multi-step workflow* the system currently
is, not on stored data alone:**
- Settings/metadata tab authorization (Owner + Application Administrator
  only) — a pure API-boundary role check.
- "No Manager-count guard" — the **absence** of a rule: 03.04/03.05 must
  specifically **not** add a count-based rejection for removing the last
  Manager (an easy mistake to copy from 15's literal text without this
  decision).
- `PENDING_PROVISIONING` → `ACTIVE` transition timing, gated on Project DB
  readiness **and** `v1` persistence (18) — workflow/orchestration logic
  spanning the provisioning job, not a single-row constraint.
- The idempotent project-creation transaction itself (creating `Project`,
  `PROJECT_OWNER` membership, and provisioning-job reference together) —
  transactional sequencing, not a standing schema constraint.

## 8. Remaining questions and precisely what remains blocked

**Explicitly NOT resolved by this decision** (still open in
`control-database-contracts.md` §5, unaffected by anything above):

- **§5.4 — who may create a project at all** (any authenticated user vs. a
  named "creation permission"). This decision only concerns the
  representation/protection of the role *after* a project exists — it does
  not decide who may start one.
- **§5.7 — Project DB connection-mapping storage** (unrelated gap).
- **§5.9 — cross-project audit correlation mechanism** (unrelated gap).
- **§5.10 — draft-to-Project conversion disposition** (unrelated gap).
- **§5.8 — invitation-validity-period storage location** (unrelated gap).
- **22's "Project Manager... limited rights must be explicitly granted in
  the project permission matrix"** — no such delegation-granting mechanism
  is designed by this decision; Manager's audit/undo access remains flatly
  "none" until a future decision designs that mechanism.

**New gaps surfaced while completing this decision** (not among the
sub-issue's seven questions; not resolved here):

- **§3.5 — Owner-account archival.** Nothing read prevents an Application
  Administrator from archiving a user who owns one or more active
  projects, and nothing read remediates the resulting state (a
  non-reassignable `PROJECT_OWNER` membership pointing to a now-unusable
  account). **Downstream behavior blocked:** 03.04 cannot decide whether
  `archive-user` (13) needs a project-ownership check, and 03.05's
  user/membership repositories cannot know whether to add one. **The user
  confirmed this should be carried forward as an explicitly reported open
  gap rather than resolved before closing 03.03** — it does not block this
  sub-issue's own completion.
- Whether Reviewer/Validator/Guest may *view* (not manage) the Team page's
  member/invitation list. No source states this either way. Recorded as
  "unspecified" in §5's matrix rather than defaulted silently; 03.04/03.05
  should obtain an explicit answer or treat it conservatively
  (Owner/Manager-only) and report that choice. Low severity, non-blocking.

**What this decision unblocks for 03.04:** the `Membership.role` and
`Membership.status` enums (§7), the Owner-per-project uniqueness
constraint, and the removal/role-change validation logic (§6) can now be
designed without guessing. **What remains blocked regardless:** anything
depending on §5.4/§5.7/§5.9/§5.10/§5.8 above, the Team-page view-only gap,
and §3.5's Owner-account archival gap (carried forward by explicit user
confirmation — see §3.5 — and blocking only 13's future `archive-user`
authorization design, not 03.03's own completion).

## 9. Planned acceptance scenarios (NOT implemented or executed)

These are proposals for 03.04/03.05 to implement and test — nothing below
has been run, and no code exists yet to run it against.

- **Forbidden role escalation:** a Project Manager attempting to change any
  member's role to `PROJECT_OWNER` is rejected — there is no such
  assignable value from the API's perspective at all (not merely a
  permission check, since the action itself does not exist).
- **Cross-project access:** a Manager/Owner authorized in project A cannot
  add, remove, or role-change a membership row in project B by supplying
  B's `projectId` — authorization always resolves from the URL project ID,
  per the existing `control-database-contracts.md` §3.4 requirement
  (unchanged by this decision).
- **Protected-member removal/demotion (via membership-management
  endpoints):** an attempt to remove or role-change the `PROJECT_OWNER`
  membership — by the Owner themself, by a Manager, or by an Application
  Administrator — is rejected in every case through any
  membership-management endpoint, with no "last member" exception logic
  involved (there is nothing to check except "is this the Owner row," full
  stop). This scenario is scoped to membership-management endpoints only —
  it says nothing about the separate, unresolved §3.5 question of archiving
  the Owner's underlying `User` account through a *different* endpoint
  (`archive-user`, 13).
- **Manager removal with zero remaining Managers:** this decision removes
  only the Manager-count guard itself. Removing the last active Manager in
  a project **succeeds when the caller is otherwise authorized to perform
  that removal and every other applicable validation/authorization rule
  passes** — explicitly verifying that the rejected "require at least one
  Manager" alternative was not silently implemented, **not** a claim that
  Manager removal is unconditionally permitted regardless of who is asking
  or what other rule might independently apply.
- **Provisioning failure/retry:** a failed project-creation attempt leaves
  no Owner membership transitioned to `ACTIVE` (it stays
  `PENDING_PROVISIONING` or the whole attempt is retried idempotently per
  guide 18 / `control-database-contracts.md` §3.3); a retry with the same
  idempotency key does not create a second Owner membership for the same
  project.
- **Concurrent changes threatening the Owner:** two concurrent requests — one
  attempting to remove the Owner membership, one attempting a legitimate
  Manager removal on the same project — never result in the Owner row being
  removed under any interleaving (the Owner-removal attempt must fail
  regardless of ordering, since it is an absolute rule, not a
  count-dependent race).
- **Settings/metadata authorization:** a Project Manager is rejected (403)
  by the role check itself on every Settings tab and every
  project-metadata/lifecycle endpoint; a `PROJECT_OWNER` or Application
  Administrator caller is **not** rejected by that specific role check —
  this does **not** mean either is guaranteed to succeed unconditionally:
  an archived project still rejects writes (`control-database-contracts.md`
  §3.3), and any resource-state, request-validation, or confirmation
  requirement that independently applies to the action still applies. An
  audit event is recorded for whichever outcome actually occurs, success or
  rejection.
- **(Deliberately not included) Owner-account archival:** no scenario for
  "archiving a project-owning user is rejected/allowed/remediated" is
  proposed here, because §3.5 records this as an unresolved gap, not an
  approved behavior — adding a test scenario for it now would imply a
  resolution this document does not make.

Per §7's three-way split, a future test suite should exercise all of: the
plain database constraints (category A — enum values, the Owner-per-project
uniqueness constraint), any additional PostgreSQL-level enforcement 03.04
chooses to add for the structural invariants in category B, and the
endpoint-authorization/workflow rules in category C — a schema constraint
alone does not prove an authorization rule, and an authorization check
alone does not prove a database-level invariant holds under direct data
access.

## 10. Cross-reference to `control-database-contracts.md`

The following sections of [`control-database-contracts.md`](control-database-contracts.md)
now reference this decision instead of presenting the conflict as fully
open (see that file's own updated text for the exact wording):

- §3.3 (Project) — the lifecycle/lifecycle-state row.
- §3.4 (Membership) — the role enum, status enum, and last-protected-member
  rows.
- §5.1 and §5.2 — marked resolved, pointing here.
- §5.5 — the Settings/metadata half of that gate is resolved; the
  authorization-matrix-for-other-actions framing is otherwise unchanged.
- §6 and §7 — the planned-verification and handoff text updated to reflect
  the approved model instead of a still-open fork.

§5.4 (who may create a project), §5.3/§5.8 (invitation expiry), §5.6 (21's
revision-job self-contradiction), §5.7, §5.9, §5.10, §5.11, §5.12 are
**unaffected** and remain exactly as recorded there.
