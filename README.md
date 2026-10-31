# SDF Lens by Strikaris

A free GitHub Action that analyzes a NetSuite SuiteCloud Development Framework (SDF) project on every pull request and posts the results as a pull-request comment: a **script inventory**, a **dependency map** of the `N/` modules your scripts use, and **sanity checks** (a missing or unparseable manifest, scripts that fail to parse).

It runs entirely on the GitHub runner inside your own repository. Your code never leaves your GitHub account, and no Strikaris server is involved.

## Install

Add a workflow to your repository (for example `.github/workflows/sdf-analysis.yml`):

```yaml
- uses: Strikaris-Tech/netsuite-sdf-action@v1
  with:
    project-path: '.'
```

That is all the setup there is. On the next pull request, the analysis appears as a comment.

## What it does

- **Script inventory** — every SuiteScript under `FileCabinet/SuiteScripts`, with its type (from the `@NScriptType` tag, or inferred from its entry points), its `@NApiVersion`, and how many modules it depends on.
- **Dependency map** — the unique `N/` and `SuiteScripts/` modules used across the project, and how many scripts use each one.
- **Sanity checks** — warnings for a missing or unparseable `manifest.xml`, a missing SuiteScripts directory, and scripts that fail to parse.

Used as a **merge gate**: set `fail-on-issues: 'true'` and the run fails when any warning is found, so a broken script cannot merge unnoticed.

## What it deliberately does not do

The free tier is inventory, dependency map, and sanity checks — nothing more. It does not link scripts to their deployment records, does not evaluate governance or compliance rules, and does not produce diagrams or audit reports. It also contains none of the paid analyzer's code: the free engine is a small standalone implementation, kept separate on purpose.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `project-path` | `.` | Path to the SDF project root (the directory containing `src/manifest.xml`). |
| `github-token` | `${{ github.token }}` | GitHub token used to post the pull-request comment. |
| `comment-mode` | `sticky` | `sticky` (edit the existing Strikaris comment), `new` (one comment per run), or `off` (no comment). |
| `fail-on-issues` | `false` | If `true`, the Action exits non-zero when analyzer warnings are found. Useful as a merge gate. |

## Outputs

| Output | Description |
| --- | --- |
| `script-count` | Number of SuiteScripts found in the project. |
| `dependency-count` | Number of unique `N/` module dependencies detected across all scripts. |
| `has-issues` | `true` if the analyzer flagged any warnings (manifest missing, script parse errors, etc.). |
| `summary-markdown` | The rendered markdown summary (same as the PR comment body) for downstream consumers. |

## Going deeper

For a deeper, human-reviewed audit of a NetSuite project — deployment linkage, findings with line-level evidence, and a remediation report — Strikaris offers the SDF Analyzer audit service.

## License

MIT
