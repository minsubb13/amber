# Releasing Amber

## Channels

Users install from the `release` branch. `main` is the development branch: pull requests merge there, and nothing on `main` reaches users until `release` moves.

```sh
claude plugin marketplace add minsubb13/amber#release
codex plugin marketplace add minsubb13/amber@release
```

A version number alone cannot hold a change back, because the two hosts update differently:

- Claude Code compares versions. `claude plugin update` skips a commit that keeps the version, but a fresh install takes the tip of the tracked branch under whatever version it names.
- Codex does not compare versions. `codex plugin marketplace upgrade` replaces the installed files with the tip of the tracked branch even when the version is unchanged.

So the tracked branch is the release: `release` only ever points at a release commit on `main`.

## Versions

Amber is 0.x. Feature and fix pull requests leave both manifests (`plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`) unchanged; only a release pull request sets the version.

- **minor** - behavior an operator or a model sees changes: skills, hook messages, the run protocol, commands and their output.
- **patch** - a defect is fixed and no behavior is added.
- **none** - internal changes (refactoring, tests, development tooling, README) ship with the next release.

There is no changelog file. The GitHub release notes, generated from the merged pull request titles, are the change record.

## Cutting a release

1. Open a pull request against `main` that sets the same version in both manifests, titled `amber: Release X.Y.Z`. Squash-merge it.
2. Move `release` to that commit. It is always a fast-forward, because `release` only ever points at a commit of `main`:

   ```sh
   git fetch origin
   git push origin <sha>:release
   ```

3. Tag it and publish the notes:

   ```sh
   gh release create vX.Y.Z --target <sha> --generate-notes
   ```

The maintainer runs steps 2 and 3. The repository allows squash merges only, so moving `release` through a pull request would give it a history of its own; a fast-forward push keeps it an ancestor of `main`.

## One-time setup

- Protect `release` with a ruleset that blocks deletion and non-fast-forward pushes.
- Create `release` at the first release commit, `86f1d0e` (0.30.0), and publish `v0.30.0` from it as in steps 2 and 3.

## Moving an existing install to `release`

An install made before `release` existed tracks `main`. Re-add the marketplace with the ref, then install again:

```sh
claude plugin marketplace remove amber
claude plugin marketplace add minsubb13/amber#release
claude plugin install amber@amber
```

```sh
codex plugin marketplace remove amber
codex plugin marketplace add minsubb13/amber@release
codex plugin add amber@amber
```

Start a new session afterwards.
