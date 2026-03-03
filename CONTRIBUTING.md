# Contributing

This repository uses the **GitFlow** branching model.

## Branch Structure

| Branch | Purpose |
|--------|---------|
| `main` | Stable production releases (tagged with version) |
| `develop` | Integration branch — all features merge here |
| `feature/*` | New features branched from `develop` |
| `bugfix/*` | Bug fixes branched from `develop` |
| `release/*` | Release preparation branched from `develop` |
| `hotfix/*` | Urgent production fixes branched from `main` |

## Workflow

### Starting a feature
```bash
git flow feature start <name>
# work on feature/name
git flow feature finish <name>
```

### Starting a bugfix
```bash
git flow bugfix start <name>
git flow bugfix finish <name>
```

### Creating a release
```bash
git flow release start <version>
# bump version, update changelog
git flow release finish <version>
```

### Creating a hotfix
```bash
git flow hotfix start <version>
# fix the issue
git flow hotfix finish <version>
```

## Rules

- Never commit directly to `main` or `develop`
- All feature/bugfix branches must be reviewed via PR before merging
- Releases and hotfixes are tagged automatically by `git flow finish`
- Tag format: `v<major>.<minor>.<patch>` (e.g., `v1.2.0`)
