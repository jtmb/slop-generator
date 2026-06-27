# 🛠️ Slop Generator

**Autonomous AI agents that generate, plan, and build software project ideas — on autopilot.**

Slop Generator is a monorepo of autonomous AI agents that use [Cline CLI](https://github.com/cline/cline) with a local [LM Studio](https://lmstudio.ai/) backend to continuously generate unique app ideas, track them in a database, and eventually build them. The planner runs as a containerized service — fire it up and watch ideas appear.

---

## ✨ What's Inside

| | |
|---|---|
| 🤖 **Autonomous agent loop** | Planning → Execution, completely unattended |
| 🧠 **Local AI backend** | Qwen 3.5 9B via LM Studio — no cloud dependency |
| 📦 **Containerized** | Docker Compose, one command to run |
| 📚 **18 ideas generated** | And counting — each unique, categorized, and documented |
| 🗃️ **Idea database** | `db.md` tracks every idea with status and metadata |
| 🔌 **Hot-swappable models** | Use any OpenAI-compatible local or cloud model |
| 📡 **Auto git sync** | Auto-commit and push generated ideas after each iteration |

---

## 🏆 Generated Ideas So Far

| # | Idea | Category | Status |
|---|------|----------|--------|
| 1 | **EcoTrack** | Sustainability / Productivity | ✅ Idea |
| 2 | **SkillSwap Connect** | Education / Social | ✅ Idea |
| 3 | **Mindful Moments** | Health & Wellness | ✅ Idea |
| 4 | **MealMatch AI** | Food & Nutrition | ✅ Idea |
| 5 | **PawPrint Tracker** | Pet Care | ✅ Idea |
| 6 | **TripSync AI** | Travel | ✅ Idea |
| 7 | **BudgetBuddy AI** | Finance | ✅ Plan |
| 8 | **CareerPath Navigator** | Career Development | ✅ Plan |
| 9 | **FitFlow Sync** | Fitness | ✅ Idea |
| 10 | **Neighborly Connect** | Community / Social | ✅ Idea |
| 11 | **RentFlow Manager** | Real Estate | ✅ Idea |
| 12 | **SmartHome Guardian** | IoT / Security | ✅ Idea |
| 13 | **HealthSync Pro** | Healthcare | ✅ Idea |
| 14 | **DeepWork Companion** | Productivity | ✅ Idea |
| 15 | **SubscriptionGuard** | Finance | ✅ Plan |
| 16 | **LocalBiz Boost** | Small Business | ✅ Idea |

Each idea lives as a structured `.md` file in `slop-planner/apps/` with problem statement, target audience, key features, monetization strategy, and tech stack recommendations.

---

## 🧠 How It Works

The agent runs in a continuous loop. Each iteration has three phases:

```
agent-runner.js
     │
     ├─── Planning Phase ───────────────────────────┐
     │    cline reads AGENTS.md + db.md              │
     │    cline formulates a new, unique idea         │
     │    cline writes /app/plan.txt                  │
     └───────────────────────────────────────────────┘
     │
     ├─── Execution Phase ───────────────────────────┐
     │    cline reads /app/plan.txt + db.md           │
     │    cline creates apps/{name}.md                │
     │    cline updates db.md                        │
     └───────────────────────────────────────────────┘
     │
     ├─── Git Sync Phase ────────────────────────────┐
     │    git-sync.js --once                         │
     │    commits new/changed files                   │
     │    pushes to remote (if configured)            │
     └───────────────────────────────────────────────┘
     │
     v
  Next iteration (until max_iterations reached)
```

### Phase 1: Planning
- Cline reads its role instructions from `AGENTS.md`
- Reviews all existing ideas in `db.md` to avoid duplicates
- Formulates a new idea concept
- Saves the plan to `/app/plan.txt`

### Phase 2: Execution
- Cline reads the plan from `/app/plan.txt`
- Creates a detailed markdown file in `apps/`
- Updates `db.md` with the new entry
- Loop repeats until `max_iterations` is reached

### Phase 3: Git Sync
- `agent-runner.js` spawns `git-sync.js --once`
- On first run: initializes a git repo, creates `.gitignore` tracking only `apps/`
- Commits any new or changed files
- Pushes to remote if `GIT_REPO_URL` is configured

---

## 🚀 Quick Start

### Prerequisites

- [Docker](https://docker.com) + [Docker Compose](https://docs.docker.com/compose/)
- [LM Studio](https://lmstudio.ai/) running locally with a loaded model (e.g., `qwen/qwen3.5-9b`)

### Run the Agent

```bash
cd slop-planner

# Build and start
docker compose up -d --build

# Watch the agent progress
docker logs slop-generator -f

# Stop when ready
docker compose down
```

The agent starts immediately and runs through its loop. Each iteration takes ~2-5 minutes depending on your model. Git sync runs automatically after each successful idea generation — no separate service needed.

---

## ⚙️ Configuration

### Environment Variables (`slop-planner/config/.env`)

| Variable | Default | Description |
|---|---|---|
| `CLINE_API_BASE_URL` | `http://192.168.0.13:1234/v1` | LM Studio API endpoint |
| `CLINE_MODEL` | `qwen/qwen3.5-9b` | Model identifier |
| `CLINE_PROVIDER` | `lmstudio` | Provider name |
| `GITHUB_TOKEN` | — | For GitHub MCP features |
| `GIT_REPO_URL` | — | Remote git URL (e.g. `https://user:token@github.com/owner/repo.git`) |
| `GIT_BRANCH` | `main` | Git branch to push to |
| `GIT_USER_NAME` | `Slop Generator` | Git commit author name |
| `GIT_USER_EMAIL` | `slop-generator@localhost` | Git commit author email |
| `GIT_SYNC_DB` | `false` | Set `true` to also sync `db.md` |

### Settings (`slop-planner/config/settings.json`)

| Key | Default | Description |
|---|---|---|
| `max_iterations` | `50` | How many ideas to generate before stopping |
| `timeout_ms` | `300000` | Per-iteration timeout (5 min) |
| `stream` | `true` | Stream cline output to console |
| `temperature` | `0.7` | LLM creativity level |

---

## 📁 Project Structure

```
slop-generator/
├── slop-planner/                 # ★ Active project — App Idea Generator
│   ├── AGENTS.md                 # Agent role & workflow instructions
│   ├── Dockerfile                # Multi-stage container build
│   ├── docker-compose.yml        # Service definition & volumes
│   ├── db.md                     # Central idea registry
│   ├── package.json              # Node.js deps (dotenv, axios)
│   ├── apps/                     # ★ Generated app ideas (.md files)
│   │   ├── eco-track.md
│   │   ├── budget-buddy-ai.md
│   │   └── ... (16+ files)
│   ├── scripts/
│   │   ├── agent-runner.js       # Main autopilot loop
│   │   └── git-sync.js           # Git sync sidecar service
│   └── config/
│       ├── .env                  # Runtime configuration
│       ├── .env.example          # Template for .env
│       └── settings.json         # Loop parameters
│
├── slop-builder/                 # Future: code generation agent
│
├── .github/                      # VS Code agent configs & CI
│   ├── agents/                   # Agent definitions
│   ├── instructions/             # Framework rules
│   └── workflows/                # CI pipeline
│
├── .clinerules/                  # Framework overlay rules
├── docs/                         # Project documentation
│   ├── TECH-STACK.md
│   ├── ARCHITECTURE.md
│   └── SLOP-PLANNER.md
├── AGENTS.md                     # Monorepo root guide
└── README.md                     # You are here ✨
```

---

## 🏗️ Architecture Highlights

### Container Design

- **Base**: `node:22-slim` (Debian, glibc — required for Cline CLI binary)
- **Stages**: Multi-stage build (builder → runtime) for small image size
- **User**: `node` (uid 1000) matches typical host UID for volume permission
- **Init**: `tini` for proper PID 1 signal handling
- **Volumes**: `apps/`, `db.md`, `config/` mounted for host-side persistence

### Services

| Service | Role |
|---|---|
| `slop-generator` | Agent loop — generates app ideas + git sync after each iteration |

Git sync runs in-process inside the agent loop. After each successful idea generation, `agent-runner.js` calls `git-sync.js --once` to commit and push any changes. No separate container needed.

### Key Design Decisions

| Decision | Rationale |
|---|---|
| `spawnSync` over `execSync` | Avoids shell quoting issues with multi-line prompts |
| File-based plan handoff | Planning writes `/app/plan.txt`, execution reads it — clean separation |
| Two-phase iteration | Prevents duplicate ideas by forcing research before execution |
| JSON provider config | `providers.json` written at startup, no manual cline setup |
| In-process git sync | Git commit/push runs inside the agent loop after each iteration — simpler than a separate container |

---

## 📄 Sample Generated App

```markdown
# EcoTrack

## Overview
EcoTrack is a comprehensive carbon footprint tracking application
that gamifies sustainable living.

## Problem Solved
Many people want to live more sustainably but lack visibility
of their personal carbon footprint and motivation to maintain habits.

## Key Features
1. **Activity Logging** — Track transportation, food, energy, shopping
2. **Personal Dashboard** — Carbon footprint trends and reduction goals
3. **Gamification** — EcoPoints, achievements, leaderboards
4. **Community Challenges** — Group sustainability goals
5. **Smart Insights** — AI-powered personalized recommendations

## Tech Stack
Frontend: React Native | Backend: Node.js + Express | DB: PostgreSQL + Redis
```

---

## 🛠️ Development

### Run Locally (without Docker)

```bash
cd slop-planner
npm install
node scripts/agent-runner.js
```

### Add a New Model

1. Load your model in LM Studio
2. Update `CLINE_MODEL` in `config/.env`
3. Restart the container

### Manual Idea Generation

```bash
cd slop-planner
cline -P lmstudio "Read AGENTS.md and db.md, then generate a new app idea"
```

---

## 🔮 Future Roadmap

- [x] Autonomous app idea generation loop
- [x] Planning module before execution
- [x] Deduplication via `db.md`
- [x] Auto git sync after each iteration
- [ ] **slop-builder**: Auto-generate starter code for each idea
- [ ] **Web dashboard**: Browse generated ideas in a UI
- [ ] **Idea quality scoring**: Rate uniqueness, feasibility, market fit
- [ ] **Multi-model**: Support OpenAI, Anthropic, Ollama backends
- [ ] **Slack/Webhook alerts**: Notify on new idea generation

---

## 🧩 Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| `ECONNREFUSED` | LM Studio not running | Start LM Studio, check port 1234 |
| `ETIMEDOUT` | Model too large / slow | Use a smaller model or increase `timeout_ms` |
| Permission denied on volumes | UID mismatch | Ensure `node` user (uid 1000) can write to `apps/` |
| Duplicate ideas | Agent not reading `db.md` | Check `AGENTS.md` instructions, verify file paths |

---

## 📚 Docs

| File | Content |
|---|---|
| `docs/TECH-STACK.md` | Full dependency list and versions |
| `docs/ARCHITECTURE.md` | Architecture decisions and flow diagrams |
| `docs/SLOP-PLANNER.md` | Planner module deep dive |
| `slop-planner/AGENTS.md` | Agent instructions and workflow |

---

## 📝 License

MIT — use it, fork it, build something with it.

---

*Generated by the Slop Generator — ideas made autonomous.*
