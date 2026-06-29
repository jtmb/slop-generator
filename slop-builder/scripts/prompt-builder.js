/**
 * Prompt Builders — All Cline prompt generation functions for the builder.
 *
 * These are pure-ish functions that construct task prompts for the AI agent.
 * They do NOT make any API calls or mutate external state — they just produce
 * strings that are fed to runCline().
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';

/**
 * Build the deep planning prompt for Cline.
 * Injects the idea JSON inline so Cline can write plan.md without reading any files.
 * Designed for Qwen 3.5 9B — single focused task, no multi-step navigation.
 *
 * @param {object} idea - Full idea object from slop-api
 * @returns {string} Prompt text
 */
export function buildDeepPlanPrompt(idea) {
  const ideaJson = JSON.stringify(idea, null, 2);
  const slug = idea.slug;

  return `You are the Planning Module. Create a detailed plan for this app idea:

\`\`\`json
${ideaJson}
\`\`\`

STEPS:
1. Read the file AGENTS.md from the current working directory. Follow all its conventions.
2. Write the plan file at /app/projects/${slug}/plan.md using the template below.
   (The project directory /app/projects/${slug} already exists.)

PLAN TEMPLATE — fill in every section.
EACH TASK MUST BE ATOMIC — one file, one endpoint, or one small component.
NO COMPOUND TASKS like "Implement routes for X, Y, and Z" — split those into separate tasks.

\`\`\`markdown
# Plan: ${idea.name}

## Framework Decision
- **Language**: (e.g., TypeScript, Python, Go)
- **Runtime/Framework**: (e.g., Express, FastAPI, Gin)
- **Package Manager**: (e.g., npm, pip, go mod)
- **Database**: (if needed)
- **Rationale**: Why this stack fits this specific idea

## Applicable .clinerules
- [.clinerules/instructions/api-design.instructions.md](.clinerules/instructions/api-design.instructions.md)
- [.clinerules/instructions/containers.instructions.md](.clinerules/instructions/containers.instructions.md)
- (add language/framework-specific ones)

## Test Command
\`npm test\`

## Phase 1: Project Setup (3-4 tasks)
- [ ] Initialize project (package.json, tsconfig, dependencies)
- [ ] Create project structure (src/, tests/, config/)
- [ ] Create Dockerfile (multi-stage, non-root user)
- [ ] Create README.md with setup instructions

## Phase 2: Data Layer (2-4 tasks)
- [ ] Define data models/schemas for [one entity]
- [ ] Set up database connection and create migration for [one table]
- [ ] Define models/schemas for [another entity] (if needed)
- [ ] Set up database connection and create migration for [second table] (if needed)

## Phase 3: API Routes (3-5 tasks — ONE endpoint per task)
- [ ] Implement POST /api/v1/[resource] route with validation
- [ ] Implement GET /api/v1/[resource] and GET /api/v1/[resource]/:id routes
- [ ] Implement PUT /api/v1/[resource]/:id and DELETE /api/v1/[resource]/:id routes
- [ ] Implement [second resource] routes (same pattern)
- [ ] Add middleware (auth, cors, logging, error handling)

## Phase 4: Business Logic (2-3 tasks)
- [ ] Implement core service for [one feature]
- [ ] Implement core service for [another feature]
- [ ] Build React/Vue component for [one UI piece] (if frontend)

## Phase 5: Testing & Polish (2-3 tasks)
- [ ] Write unit tests for [one service/feature]
- [ ] Write integration test for [one endpoint]
- [ ] Add health check endpoint, final cleanup
\`\`\`

RULES:
- Each task MUST be a SINGLE atomic operation — one endpoint, one model, one component.
- BAD: "Implement REST API routes for projects CRUD, budget tracking, material inventory" (4+ endpoints)
- GOOD: "Implement POST /api/v1/projects route with validation"
- TOTAL tasks: 12-20. More granular tasks = higher success rate.
- Include a \`## Test Command\` section with the exact command to run tests (e.g., \`npm test\`).
- Do NOT create any code yet — this is the PLANNING phase only.
- Do NOT modify db.md or any files outside /app/projects/${slug}/.
- Do NOT read any files — all context is provided here.
- When the plan.md is written, say DONE.`;
}

/**
 * Build the execution prompt for Cline.
 * Instructs Cline to read plan.md and execute the next unchecked phase.
 *
 * @deprecated Use buildSimpleTaskPrompt() instead — complex multi-step prompts
 * cause Qwen 3.5 9B to hallucinate completion without making tool calls.
 *
 * @param {string} projectDir
 * @param {string} planPath
 * @returns {string} Prompt text
 */
export function buildExecutePrompt(projectDir, planPath) {
  return `You are the **Execution Module** of the App Builder.

Read the file AGENTS.md from the current working directory to understand your role and workflow.

Then, execute the NEXT UNCHECKED PHASE from the plan at ${planPath}.

Follow these steps EXACTLY:
1. Read ${planPath} to find the first phase with any unchecked \`- [ ]\` items.
2. Read the .clinerules/instructions/ files listed in the plan's "Applicable .clinerules" section.
3. Execute ALL unchecked items in that phase — write actual code, not stubs.
4. As you complete each item, update plan.md: change \`- [ ]\` to \`- [x]\` using node -e with fs.readFileSync + String.replace + fs.writeFileSync.
5. Follow all AGENTS.md conventions: comments, error handling, secure coding, naming, reusable code.

STOP after completing ONE phase. Do not start the next phase.

Write real, production-quality code. Do NOT write stubs or TODOs. Every file must be a complete, working implementation.`;
}

/**
 * Parse plan.md and return the first unchecked task.
 *
 * @param {string} planPath
 * @returns {{ taskText: string, lineNumber: number, phaseHeading: string }|null}
 */
export function parseNextUncheckedTask(planPath) {
  if (!existsSync(planPath)) return null;

  const lines = readFileSync(planPath, 'utf-8').split('\n');
  let currentPhase = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track which phase we're in (## Phase N: ...)
    if (/^##\s+Phase\s+\d/.test(line)) {
      currentPhase = line.replace(/^##\s+/, '').trim();
      continue;
    }

    // Found an unchecked item
    if (/^\s*- \[ \]/.test(line)) {
      const taskText = line.replace(/^\s*- \[ \]\s*/, '').trim();
      return {
        taskText,
        lineNumber: i,
        phaseHeading: currentPhase || 'Unknown Phase'
      };
    }
  }

  return null;
}

/**
 * Mark a plan.md task as complete by changing - [ ] to - [x].
 * Operates on a specific line number.
 *
 * @param {string} planPath
 * @param {number} lineNumber — 0-indexed
 * @returns {boolean} True if the line was successfully marked done
 */
export function markTaskDone(planPath, lineNumber) {
  const lines = readFileSync(planPath, 'utf-8').split('\n');
  if (lineNumber < 0 || lineNumber >= lines.length) {
    return false;
  }

  const line = lines[lineNumber];
  if (!/^\s*- \[ \]/.test(line)) {
    return false;
  }

  lines[lineNumber] = line.replace('- [ ]', '- [x]');
  writeFileSync(planPath, lines.join('\n'), 'utf-8');
  return true;
}

/**
 * Extract the key context from plan.md that Cline needs to generate code.
 * Returns the Framework Decision and .clinerules sections — much smaller
 * than the full plan, avoids timeouts on slow models reading 200+ lines.
 *
 * @param {string} planPath
 * @returns {string} Condensed plan context
 */
export function extractPlanContext(planPath) {
  if (!existsSync(planPath)) return '';

  const content = readFileSync(planPath, 'utf-8');
  const lines = content.split('\n');
  let frameworkSection = '';
  let clinerulesSection = '';
  let inFramework = false;
  let inClinerules = false;

  for (const line of lines) {
    if (line.startsWith('## Framework Decision')) {
      inFramework = true;
      continue;
    }
    if (line.startsWith('## ')) {
      if (line.startsWith('## Applicable .clinerules')) {
        inClinerules = true;
        inFramework = false;
        continue;
      }
      if (inFramework || inClinerules) break; // Next section — done
      continue;
    }
    if (inFramework) frameworkSection += line + '\n';
    if (inClinerules) clinerulesSection += line + '\n';
  }

  let context = '';
  if (frameworkSection.trim()) {
    context += '## Framework Decision\n' + frameworkSection.trim() + '\n\n';
  }
  if (clinerulesSection.trim()) {
    context += '## Applicable .clinerules\n' + clinerulesSection.trim() + '\n\n';
  }
  return context;
}

/**
 * Build a simple, single-task prompt for Cline.
 * Designed for Qwen 3.5 9B — no multi-step navigation, no plan.md reading.
 * Just: given context → create files → DONE.
 *
 * @param {string} slug
 * @param {string} projectDir
 * @param {string} planPath
 * @param {{ taskText: string, phaseHeading: string }} taskInfo
 * @returns {string} Prompt text
 */
export function buildSimpleTaskPrompt(slug, projectDir, planPath, taskInfo) {
  const { taskText, phaseHeading } = taskInfo;

  // Extract plan context in JS so Cline doesn't need to read the full plan
  const planContext = extractPlanContext(planPath);

  // Determine file type from task description for guidance
  let fileHint = '';
  const taskLower = taskText.toLowerCase();
  if (taskLower.includes('dockerfile')) fileHint = '\nCreate Dockerfile at /app/projects/' + slug + '/Dockerfile';
  else if (taskLower.includes('package.json') || taskLower.includes('init')) fileHint = '\nCreate /app/projects/' + slug + '/package.json and config files';
  else if (taskLower.includes('readme')) fileHint = '\nCreate /app/projects/' + slug + '/README.md';
  else if (taskLower.includes('test') || taskLower.includes('spec')) fileHint = '\nCreate test files in /app/projects/' + slug + '/';
  else if (taskLower.includes('route') || taskLower.includes('endpoint') || taskLower.includes('api'))
    fileHint = '\nCreate route/API files in /app/projects/' + slug + '/';
  else if (taskLower.includes('component') || taskLower.includes('ui') || taskLower.includes('frontend'))
    fileHint = '\nCreate component files in /app/projects/' + slug + '/';
  else if (taskLower.includes('model') || taskLower.includes('schema') || taskLower.includes('database'))
    fileHint = '\nCreate model/schema files in /app/projects/' + slug + '/';
  else if (taskLower.includes('middleware'))
    fileHint = '\nCreate middleware files in /app/projects/' + slug + '/';
  else fileHint = '\nCreate the necessary files in /app/projects/' + slug + '/';

  return `PROJECT CONTEXT:
${planContext}

YOUR TASK (Phase "${phaseHeading}"):
${taskText}

${fileHint}

Write REAL code — complete implementations, no stubs.
Use ONLY the run_commands tool to create files.
Do NOT read any files — context is provided above.
The editor tool is BROKEN — do NOT use it.
Do NOT try to update plan.md — the JS runner handles checkmarks.
When finished, say DONE.`;
}

/**
 * Build a retry prompt that tells Cline exactly what failed so it can adapt.
 * Never retry with the same prompt — that guarantees the same failure.
 *
 * @param {string} slug
 * @param {string} projectDir
 * @param {string} planPath
 * @param {{ taskText: string, phaseHeading: string }} taskInfo
 * @param {number} attempt — Which retry attempt this is (1-indexed)
 * @param {string} errMsg — The error message from the previous attempt
 * @returns {string} Prompt text with recovery guidance
 */
export function buildTaskRetryPrompt(slug, projectDir, planPath, taskInfo, attempt, errMsg) {
  const base = buildSimpleTaskPrompt(slug, projectDir, planPath, taskInfo);

  // Classify the failure and give targeted recovery instructions
  let diagnosis;
  const errLower = errMsg.toLowerCase();

  if (errLower.includes('timed out') || errLower.includes('timeout')) {
    diagnosis = `\n\n⚠️  PREVIOUS ATTEMPT #${attempt} TIMED OUT.
THE TASK IS TOO COMPLEX FOR ONE CALL. DO THIS INSTEAD:
- Pick a SMALLER piece of the task and implement only that.
- Write 1-3 files max. Skip anything non-essential.
- Leave complete implementations — no stubs — but narrow the scope.
- Say DONE when you've written at least ONE file.`;
  } else if (errLower.includes('peg-native') || errLower.includes('format')) {
    diagnosis = `\n\n⚠️  PREVIOUS ATTEMPT #${attempt} FAILED WITH MODEL FORMAT ERROR.
YOUR OUTPUT DID NOT MATCH THE EXPECTED FORMAT. DO THIS INSTEAD:
- Use SHORTER code blocks. Keep each file under 200 lines.
- Avoid deeply nested code, complex generics, or long template literals.
- Write simpler implementations that still work.
- Say DONE when you've created the files.`;
  } else {
    diagnosis = `\n\n⚠️  PREVIOUS ATTEMPT #${attempt} FAILED: ${errMsg.substring(0, 200)}
DO THIS INSTEAD:
- Try a DIFFERENT approach to the task.
- Write fewer, simpler files.
- Focus on the core functionality only.
- Say DONE when you've created the files.`;
  }

  return base + diagnosis;
}
