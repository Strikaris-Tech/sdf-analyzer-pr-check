# SDF Analyzer — PR Check by Strikaris

*See what every pull request changes — and catch what it introduces.*

A free GitHub Action that analyzes a NetSuite SuiteCloud Development Framework (SDF) project on every pull request and posts the results as a pull-request comment: a **script inventory**, a **dependency map** of the `N/` modules your scripts use, and **sanity checks** (a missing or unparseable manifest, scripts that fail to parse). On every pull request it also runs **six pattern checks** over the files the pull request changed, and reports only the findings that pull request introduces. It also includes a **call diagram** for each changed file: a sequence diagram of the direct calls between the functions within that file.

Repositories that are not SDF projects are covered too: if there is no project to analyze, the Action inventories the **loose SuiteScript files** in the repository instead (see "Two modes" below).

It runs entirely on the GitHub runner inside your own repository. Your code never leaves your GitHub account, and no Strikaris server is involved. It is MIT-licensed, and the code is public. You can read exactly what will run in your pipeline before you install it.

![SDF Analyzer — PR Check running on a pull request](https://raw.githubusercontent.com/Strikaris-Tech/sdf-analyzer-pr-check/v1/docs/demo.gif)

## Install

Create a workflow file in your repository (for example `.github/workflows/sdf-analysis.yml`) with this content:

```yaml
name: SDF analysis

on: pull_request

permissions:
  contents: read
  pull-requests: write

jobs:
  sdf-analysis:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: Strikaris-Tech/sdf-analyzer-pr-check@v1
        with:
          project-path: '.'
```

Three parts of that example matter:

- **The trigger is `pull_request`.** The pattern checks compare each changed file against its version on the pull request's base branch. On other events they do not run, and `findings-count` reports 0.
- **The checkout fetches the full history (`fetch-depth: 0`).** The default checkout fetches a single commit, which leaves the base version of a changed file unavailable. In that case the pattern checks report that they were not run, rather than guessing. The inventory, dependency map, and sanity checks work either way.
- **The token needs `pull-requests: write`.** The results are posted as a pull-request comment, and the `permissions` block above grants exactly what that takes. If your repository's default workflow token is read-only (the default for accounts and organizations created since February 2023), the block is what makes the comment possible. Pull requests from forks run with a read-only token, so on fork pull requests the Action runs but cannot post its comment.

If your repository already has a workflow that runs on pull requests, you need only the two steps, the checkout with `fetch-depth: 0` and the `uses:` step, plus the `pull-requests: write` permission on that workflow.

That is all the setup there is. On the next pull request, the analysis appears as a comment. There is no sign-up, no Strikaris account, and nothing to configure on any server. The Action runs on GitHub-hosted runners. On a self-hosted runner it needs a current runner version, because the Action itself runs on Node 24. To remove it, delete the workflow file. Nothing is installed anywhere else.

## What it does

- **Script inventory**: every SuiteScript under `FileCabinet/SuiteScripts`, with its type (from the `@NScriptType` tag, or inferred from its entry points), its `@NApiVersion`, and how many modules it depends on.
- **Dependency map**: the unique `N/` and `SuiteScripts/` modules used across the project, and how many scripts use each one.
- **Sanity checks**: warnings for a missing or unparseable `manifest.xml`, a missing SuiteScripts directory, and scripts that fail to parse.
- **Pattern checks**: on a pull request, the files it changed are checked for six patterns: a **hardcoded credential** written into the source, **dynamic code execution** (`eval` and its equivalents), an **empty catch block** that swallows errors silently, a **log call carrying a credential- or personal-data-shaped value**, a call to a retired **SuiteScript 1.0 API** (`nlapi…` and `nlobj…`), and a **synchronous web call in a client script**. Each changed file is compared against its version on the base branch, and only findings the pull request introduces are reported. Pre-existing findings in the same files are not.
- **Call diagram**: for each changed file, a sequence diagram of the direct calls between the functions within that file. The diagram section closes with its own line counting any changed TypeScript files, because only JavaScript files are diagrammed.
- **TypeScript accounting**: the pattern checks and the call diagram read JavaScript only. A changed TypeScript file is counted in the comment, never examined, and never passed over silently. The comment header states how many of the changed script files the checks ran on (for example, "ran on 1 of 3 changed script files"). The checks section prints a line counting the changed TypeScript files and stating that they were not examined.

Used as a **merge gate**: set `fail-on-issues: 'true'` and the run fails when any warning is found, so a broken script cannot merge unnoticed. Set `fail-on-findings: 'true'` and the run fails when the pattern checks report new findings. The two gates are independent and both default to off.

## Project layout

Project mode accepts either SDF layout: `manifest.xml` under `src/` or at the project root, with SuiteScripts under `src/FileCabinet/SuiteScripts` or `FileCabinet/SuiteScripts`. Partial projects are fine. A manifest whose SuiteScripts directory is missing (or the reverse) is analyzed as far as it goes, with the gap reported as a sanity warning rather than an error. If annotated SuiteScript files are found outside the project's SuiteScripts folders, the comment notes them as seen but not scanned, with their count.

## Two modes

- **Project mode** (an SDF project layout is present). The full behavior above: inventory, dependency map, and sanity checks.
- **Loose-file mode** (no SDF project found). The Action scans the repository tree for SuiteScript files, recognized by the `@NApiVersion` and `@NScriptType` annotations every SuiteScript carries, and posts an inventory of what it finds: each file's path, script type, API version, and the `N/` modules it declares, with counts by script type. Loose-file mode reports inventory and dependencies, with no sanity checks, and, on pull requests, the same six pattern checks on the changed files. (`node_modules`, `dist`, and `.git` are never scanned.)

If neither an SDF project nor any SuiteScript file is found, the comment says so plainly. It never reports a bare zero as if the repository had passed a check.

## What it deliberately does not do

The free tier is inventory, dependency map, sanity checks, the six pattern checks, and a reduced call diagram for each changed file, and nothing more. The pattern checks examine only the files a pull request changed, for the six patterns above. They are not an audit: the rest of the project, data flow within and between files, deployments, roles, and configuration are not examined. The pattern checks and the call diagram read JavaScript only: a TypeScript file changed by a pull request is counted in the comment and reported as not examined, never passed over silently. The Action does not link scripts to their deployment records, does not evaluate governance or compliance rules, and does not produce audit reports. The call diagram it produces is reduced: one per changed file, showing direct calls within that file only. It does not produce the paid analyzer's whole-project diagrams, which stitch calls across files and resolve indirect references. It also contains none of the paid analyzer's code: the free engine is a small standalone implementation, kept separate on purpose.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `project-path` | `.` | Path to the SDF project root (the directory containing `src/manifest.xml`). If no SDF project is found there, loose SuiteScript files under that path are inventoried instead. |
| `github-token` | `${{ github.token }}` | GitHub token used to post the pull-request comment. |
| `comment-mode` | `sticky` | `sticky` (edit the existing Strikaris comment), `new` (one comment per run), or `off` (no comment). |
| `fail-on-issues` | `false` | If `true`, the Action exits non-zero when analyzer warnings are found. Useful as a merge gate. |
| `fail-on-findings` | `false` | If `true`, the Action exits non-zero when the pattern checks report new findings on the pull request. Independent of `fail-on-issues`. |

## Outputs

| Output | Description |
| --- | --- |
| `script-count` | Number of SuiteScripts found — in the SDF project, or as loose files when no project is present. |
| `dependency-count` | Number of unique `N/` module dependencies detected across all scripts found. |
| `has-issues` | `true` if the analyzer flagged any warnings (manifest missing, script parse errors, etc.). |
| `findings-count` | Number of new pattern-check findings the pull request introduces (0 on non-pull-request runs and when the checks were skipped). |
| `has-findings` | `true` if the pattern checks reported any new findings on the pull request. |
| `summary-markdown` | The rendered markdown summary (same as the PR comment body) for downstream consumers. |

The dependency map in the comment lists both `N/` and `SuiteScripts/` modules. The `dependency-count` output above counts `N/` modules only.

## Going deeper

For a deeper, human-reviewed audit of a NetSuite project, with deployment linkage, findings with line-level evidence, and a remediation report, Strikaris offers the SDF Analyzer Audit service. See [strikaris.com](https://strikaris.com).

## License

MIT. The full source is in this repository. You can read exactly what will run in your pipeline before you install it.

---
