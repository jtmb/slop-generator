/**
 * Prompt Builders — Cline prompt generation functions for the Planner.
 *
 * The planner has two phases per iteration:
 * 1. Planning — research and formulate a plan, saved to /app/plan.txt
 * 2. Execution — read the plan and create the app idea markdown file + update db.md
 *
 * These are pure functions that produce prompt strings — no I/O, no state.
 */

/**
 * Build the planning prompt — instructs Cline to research and formulate a plan
 * without executing anything yet. The plan is saved to a file for handoff.
 *
 * @returns {string} Prompt text
 */
export function buildPlanPrompt() {
  return `You are the **Planning Module** of the App Idea Generator.

Your job is ONLY to research and plan. DO NOT create any files in apps/ and DO NOT modify db.md.

Follow these steps:
1. Read the file AGENTS.md from the current working directory to understand the full workflow.
2. Read the file db.md from the current working directory to see all existing ideas.
3. Analyze what categories and ideas already exist to avoid duplicates.
4. Formulate a detailed plan for ONE new, unique app idea.

Write your plan to /app/plan.txt using run_commands with node -e and fs.writeFileSync:

**App Name**: {proposed app name}
**Category**: {category}
**Problem It Solves**: {1-2 sentence summary}
**Why It's Unique**: {how it differs from existing ideas in db.md}
**Key Features**: {2-3 bullet points}
**Target Audience**: {who}

TOOL USAGE RULES:
- Use run_commands for ALL file operations. Split command and args: {"command":"node","args":["-e","require('fs').writeFileSync('/app/plan.txt','content')"]}
- NEVER use the editor tool — it is broken and will fail.
- For multi-line files, use \\n inside the string argument to writeFileSync.

IMPORTANT: Do NOT create any files in apps/. Do NOT modify db.md. Just research, plan, and write /app/plan.txt.`;
}

/**
 * Build the execution prompt — instructs Cline to read the plan and execute it.
 * Cline reads /app/plan.txt, creates the app idea file in apps/, and updates db.md.
 *
 * @returns {string} Prompt text
 */
export function buildAgentPrompt() {
  return `You are the **Execution Module** of the App Idea Generator.

The Planning Module has written its plan to /app/plan.txt. Read that file first.

Your job is to execute this plan. Follow these steps:
1. Read the file /app/plan.txt to get the plan.
2. Read the file db.md to confirm current state.
3. Create the app idea markdown file in the apps/ directory using run_commands with node -e and fs.writeFileSync.
4. Update db.md to add the new idea to the database using node -e with fs.readFileSync + fs.appendFileSync.

TOOL USAGE RULES:
- Use run_commands for ALL file operations. Split command and args: {"command":"node","args":["-e","require('fs').writeFileSync('apps/idea.md','content')"]}
- NEVER use the editor tool — it is broken and will fail.
- For multi-line files, use \\n inside the string argument to writeFileSync.
- To append to db.md, use: node -e "require('fs').appendFileSync('db.md','\\n| ... |')"

IMPORTANT: Actually create and update the files — do not just describe what you would do.`;
}
