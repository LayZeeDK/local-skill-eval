# Agents

## Long-running commands

When a task requires a command that may exceed 2 minutes (benchmarks, builds, deployments):
- Use `run_in_background: true` and wait for the completion notification.
- NEVER poll with sleep loops, `cat | tail`, or repeated reads of the output file.
- If you need the result before proceeding, state that you are waiting and stop.

## Ollama

- Only one Ollama model should be loaded at a time. Run `ollama stop <model>` between experiments to free memory before loading the next model.

## GitHub CLI (fork-aware)

This repo is a fork. The `gh` CLI often defaults to the **upstream** repo (`mgechev/skill-eval`) instead of the **origin** (`LayZeeDK/local-skill-eval`).

**Every `gh pr` (and `gh run`, `gh api repos/…`) command MUST include `--repo LayZeeDK/local-skill-eval`** to target the origin fork. Without it, commands silently operate against the upstream repo — creating PRs in the wrong place, viewing the wrong runs, or fetching the wrong logs.

```bash
# GOOD — explicit repo on every command
gh pr create --repo LayZeeDK/local-skill-eval --title "..." --body "..."
gh pr view 3 --repo LayZeeDK/local-skill-eval
gh pr list --repo LayZeeDK/local-skill-eval --state open
gh run list --repo LayZeeDK/local-skill-eval --limit 5
gh api repos/LayZeeDK/local-skill-eval/actions/runs

# BAD — targets upstream by default in a fork
gh pr create --title "..."
gh pr view 3
gh run list
```

**Default to origin** (`LayZeeDK/local-skill-eval`) unless explicitly instructed to target upstream (`mgechev/skill-eval`).

## Open-Closed Principle (upstream fork)

This repo is a fork of `mgechev/skill-eval`. Apply the Open-Closed Principle to upstream code:
- **Open for extension** -- add new files, new classes, new modules alongside upstream code.
- **Closed for modification** -- avoid editing files that exist in the upstream repo. When you must change upstream behavior, prefer wrapping, subclassing, or composing over direct edits.
- When upstream modification is unavoidable, keep changes minimal and clearly commented so they can be rebased when upstream updates.
