# SkillSwap Connect — Implementation Plan

## Framework Decision
- **Frontend**: Next.js 14 (App Router) with TypeScript
- **Backend**: Node.js with Express
- **Database**: PostgreSQL with Prisma ORM
- **Realtime**: Socket.io for live sessions

## Applicable .clinerules
- `nextjs.instructions.md` — Next.js App Router conventions
- `typescript.instructions.md` — TypeScript strict mode
- `api-design.instructions.md` — REST API conventions

---

## Phase 1: Scaffolding
- [x] Initialize Next.js project with `create-next-app`
- [x] Add TypeScript, ESLint, Prettier configs
- [x] Set up folder structure (app/, components/, lib/, tests/)
- [x] Configure vitest for testing

## Phase 2: Database
- [x] Set up PostgreSQL schema with Prisma
- [x] Create User, Skill, Session, Credit models
- [x] Add database seeding script

## Phase 3: Backend API
- [ ] Create auth routes (register, login, JWT)
- [ ] Create skill matching endpoint
- [ ] Create session booking endpoint
- [ ] Create credit system endpoints

## Phase 4: Frontend
- [ ] Build landing page
- [ ] Build user dashboard
- [ ] Build skill matching UI
- [ ] Build live session component

## Phase 5: Features
- [ ] Implement video calling (WebRTC)
- [ ] Implement whiteboard sharing
- [ ] Implement credit system logic

## Phase 6: Testing
- [ ] Unit tests for all API routes
- [ ] Component tests for key UI elements
- [ ] E2E test for core user flow

## Phase 7: Production Readiness
- [ ] Add error boundaries
- [ ] Add rate limiting
- [ ] Configure CI/CD pipeline
- [ ] Performance optimization

---

## Test Command
```
cd projects/skill-swap-connect && npx vitest run
```
