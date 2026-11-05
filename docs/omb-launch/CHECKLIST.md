# Launch checklist

Mark an item complete only when its outcome has been verified. See [current status](STATUS.md) for the snapshot and [technical investigations](DIGS-INDEX.md) for the remaining risks.

## 1. Repeatable scheduled coding — complete

- [x] A scheduled coding run produced a review draft. The related change was merged as `cc7bac96c4e6551d67f692fa139e69457b2700c6` (#120).

## 2. Crash-safe settlement — open

- [x] Identify the [effect recovery and publication gaps](ralph-seams-gap.md).
- [ ] Verify that a restart can reconcile a prepared outward effect without repeating an uncertain write.
- [ ] Review the resulting change and its failure tests.

## 3. Playbook parity — open

- [x] Investigate [playbook discovery and version drift](poteto-parity-verify.md).
- [ ] Check discovery and behavior on the coding host, not only the installed skill name.

## 4. Always-on coding host — required, open

- [x] Draft the [host design](launchd-always-on-brief.md).
- [ ] Select a single storage owner and a pinned executable version.
- [ ] Run the coding service under launchd with restart handling.
- [ ] Verify recovery after a service crash and host restart.

## 5. Recurring tracker work — deferred

- [ ] Move recurring tracking into OpenMausBot only after items 1–4 are complete and the coding launch works as planned.

Package publication is a separate decision; it is not a shortcut through these checks.
