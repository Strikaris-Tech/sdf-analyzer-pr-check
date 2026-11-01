# SDF Analyzer — PR Check by Strikaris

A free GitHub Action that analyzes a NetSuite SuiteCloud Development Framework (SDF) project on every pull request and posts the results as a pull-request comment: a **script inventory**, a **dependency map** of the `N/` modules your scripts use, and **sanity checks** (a missing or unparseable manifest, scripts that fail to parse).

Repositories that are not SDF projects are covered too: if there is no project to analyze, the Action inventories the **loose SuiteScript files** in the repository instead (see "Two modes" below).

It runs entirely on the GitHub runner inside your own repository. Your code never leaves your GitHub account, and no Strikaris server is involved.

## Install

Add a workflow to your repository (for example `.github/workflows/sdf-analysis.yml`):

```yaml
- uses: Strikaris-Tech/sdf-analyzer-pr-check@v1
  with:
    project-path: '.'
```

That is all the setup there is. On the next pull request, the analysis appears as a comment.

## What it does

- **Script inventory** — every SuiteScript under `FileCabinet/SuiteScripts`, with its type (from the `@NScriptType` tag, or inferred from its entry points), its `@NApiVersion`, and how many modules it depends on.
- **Dependency map** — the unique `N/` and `SuiteScripts/` modules used across the project, and how many scripts use each one.
- **Sanity checks** — warnings for a missing or unparseable `manifest.xml`, a missing SuiteScripts directory, and scripts that fail to parse.

Used as a **merge gate**: set `fail-on-issues: 'true'` and the run fails when any warning is found, so a broken script cannot merge unnoticed.

## Project layout

Project mode accepts either SDF layout: `manifest.xml` under `src/` or at the project root, with SuiteScripts under `src/FileCabinet/SuiteScripts` or `FileCabinet/SuiteScripts`. Partial projects are fine — a manifest whose SuiteScripts directory is missing (or the reverse) is analyzed as far as it goes, with the gap reported as a sanity warning rather than an error. If annotated SuiteScript files are found outside the project's SuiteScripts folders, the comment notes them as seen but not scanned, with their count.

## Two modes

- **Project mode** (an SDF project layout is present) — the full behavior above: inventory, dependency map, and sanity checks.
- **Loose-file mode** (no SDF project found) — the Action scans the repository tree for SuiteScript files, recognized by the `@NApiVersion` and `@NScriptType` annotations every SuiteScript carries, and posts an inventory of what it finds: each file's path, script type, API version, and the `N/` modules it declares, with counts by script type. Loose-file mode reports inventory and dependencies only — no sanity checks. (`node_modules`, `dist`, and `.git` are never scanned.)

If neither an SDF project nor any SuiteScript file is found, the comment says so plainly — it never reports a bare zero as if the repository had passed a check.

## What it deliberately does not do

The free tier is inventory, dependency map, and sanity checks — nothing more. It does not link scripts to their deployment records, does not evaluate governance or compliance rules, and does not produce diagrams or audit reports. It also contains none of the paid analyzer's code: the free engine is a small standalone implementation, kept separate on purpose.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `project-path` | `.` | Path to the SDF project root (the directory containing `src/manifest.xml`). If no SDF project is found there, loose SuiteScript files under that path are inventoried instead. |
| `github-token` | `${{ github.token }}` | GitHub token used to post the pull-request comment. |
| `comment-mode` | `sticky` | `sticky` (edit the existing Strikaris comment), `new` (one comment per run), or `off` (no comment). |
| `fail-on-issues` | `false` | If `true`, the Action exits non-zero when analyzer warnings are found. Useful as a merge gate. |

## Outputs

| Output | Description |
| --- | --- |
| `script-count` | Number of SuiteScripts found — in the SDF project, or as loose files when no project is present. |
| `dependency-count` | Number of unique `N/` module dependencies detected across all scripts found. |
| `has-issues` | `true` if the analyzer flagged any warnings (manifest missing, script parse errors, etc.). |
| `summary-markdown` | The rendered markdown summary (same as the PR comment body) for downstream consumers. |

## Going deeper

For a deeper, human-reviewed audit of a NetSuite project — deployment linkage, findings with line-level evidence, and a remediation report — Strikaris offers the SDF Analyzer Audit service.

## License

MIT
