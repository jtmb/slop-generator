---
description: "Analyze any public GitHub repo and write a polished MDX blog post about it — fetches README, tech stack, and file tree via unauthenticated API"
argument-hint: "Repo name or URL (e.g. jtmb/ansible-rke2-rancher)"
agent: "agent"
---

Your task is to look at a GitHub repository, understand what it does, and write a polished, technical MDX blog post about it. Save the post to `src/content/posts/{slug}.mdx` in this project.

## 1. Gather Context

First, determine which repo to analyze. If the user provided a repo name (e.g. `jtmb/ansible-rke2-rancher`) or a full URL, use that. Otherwise, ask the user which repo to write about.

Fetch the repo from the GitHub REST API (no auth needed, public repos only):

```
GET https://api.github.com/repos/{owner}/{repo}
Accept: application/vnd.github.v3+json
```

Key fields from the response:
- `name`, `description`, `language`, `topics`, `stargazers_count`
- `html_url`, `homepage` (if any)
- `created_at`, `updated_at`, `pushed_at`

Then fetch the README:

```
GET https://api.github.com/repos/{owner}/{repo}/readme
Accept: application/vnd.github.v3+json
```

The response has `content` (base64-encoded) and `download_url`. Decode the content to get the raw README text.

Optionally, fetch the repo's file tree to understand structure:

```
GET https://api.github.com/repos/{owner}/{repo}/git/trees/main?recursive=1
Accept: application/vnd.github.v3+json
```

This gives you `tree[]` with `path`, `type`, and `size` — use it to identify the tech stack (Dockerfile, package.json, go.mod, pyproject.toml, ansible/, terraform/, etc.).

## 2. Analyze the Repo

From the gathered data, answer these questions in your analysis:

- **What problem does this repo solve?** (Read the README description and opening paragraphs)
- **What's the tech stack?** (Languages, frameworks, tools visible in the file tree)
- **How is it structured?** (Entry point, key files, configuration approach)
- **How do you use it?** (Installation steps, prerequisites, usage examples from README)
- **What makes it interesting or different?** (Unique approach, clever automation, hard problem solved)

## 3. Write the Blog Post

Create the file at `src/content/posts/{slug}.mdx`. The slug should be kebab-case, derived from the repo name (e.g., `ansible-rke2-rancher` → `ansible-rke2-rancher`). Use today's date (YYYY-MM-DD).

### Frontmatter Format

```yaml
---
title: "A Compelling Title — Not Just the Repo Name"
description: "One or two sentences explaining what the post covers. Aim for 120-160 characters."
date: "YYYY-MM-DD"
tags: [Tag1, Tag2, Tag3]
author: James
---
```

### Post Structure

Follow this pattern (see existing posts in `src/content/posts/` for style reference):

**Opening section** — 2-3 paragraphs introducing the problem and why the repo matters. Use bold for emphasis, conversational tone.

**Technical deep-dive** — Walk through the key parts of the repo. Include:
- Code blocks with language hints (```yaml, ```bash, ```typescript, etc.)
- Configuration snippets showing the interesting bits
- Architecture decisions where evident from the code

**How it fits** — 1-2 paragraphs connecting this repo to the broader DevOps/homelab/automation ecosystem.

**Closing** — A short wrap-up and a link back to the repo:
```mdx
> **Check it out**: [{repo-name}](https://github.com/{owner}/{repo})
```

### Writing Style Rules

- **Conversational, not academic.** Write like you're explaining to a fellow engineer.
- **Technical but accessible.** Assume the reader knows DevOps basics but explain the specifics.
- **Show, don't just tell.** Include code snippets, config fragments, architecture diagrams (ASCII).
- **Bold key terms** on first use.
- **Use em-dashes (—)** for asides, not parentheses.
- **Section headers** use `##` for top-level, `###` for subsections.
- **Lists** for steps, options, or feature breakdowns.
- **Blockquotes** (`>`) for tips, warnings, or key takeaways.

### Length

Aim for 500-1000 words. Longer posts are fine for complex repos; shorter is fine for simple tools. Quality over quantity.

## 4. Verify

After writing the post, run the type-check and build to make sure nothing is broken:

```bash
npx tsc --noEmit
npm run build
```

The post should appear at `/blog/{slug}` in the dev server.

## Example

For a repo like `jtmb/ez-backups`:
- **Slug**: `ez-backups`
- **Title**: "Painless Docker Volume Backups with ez-backups"
- **Tags**: `[Docker, Backups, DevOps, Self-Hosted]`
- **Content**: Walk through the backup strategy, show the docker-compose config, explain cron scheduling, discuss restore scenarios.
