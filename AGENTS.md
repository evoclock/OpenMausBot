# OpenMausBot agent notes

Before claiming a server or conversation change works, follow
[`docs/verification/README.md`](docs/verification/README.md). Launch an isolated
fixture for verification. Permission release checks may additionally use a running
app only when the owner explicitly names its URL, test bot ID and test thread ID.
Before a live check, recheck that exact thread's provider, permission mode and idle
state; preserve its original settings and restore any test changes. Use harmless
scoped operations and record the prompt, effective mode, decision, outcome,
timestamps and issuing component. Keep all other bots, conversations and user
data isolated. This exception permits no installs, deletion, publication,
sensitive screen capture or external writes, and does not bypass any approval.
A session that already loaded the fixture-only rule must hand off live checks to
a fresh session that loads this amendment.

## Comments

Write a comment only for what the code cannot say:

- a license or attribution notice;
- a fact forced by something outside this code (a vendor, CLI, OS, browser,
  Electron or protocol behaviour), with its version when it has one;
- the doc comment of a public contract: the wire types in `shared/`, the
  driver interface, the preload bridge, `config.json` fields people edit;
- a link to an upstream issue;
- a security invariant or a known open risk.

Do not narrate what the next line does, restate a name, record history ("used
to", "no longer", PR or issue numbers, plan or slice names: git has it), point
at other files, draw banners or leave commented-out code. When our own code
needs a paragraph to explain a surprise, change the code instead: a better
name, a type, an extracted function, one shared helper. A rule ("never X",
"must match Y") belongs in a type, a test or a lint rule. Never suppress a lint
rule that guards correctness; fix the code.

More specific `AGENTS.md` files override this note within their directories.
