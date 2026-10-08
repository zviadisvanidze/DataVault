# Repository Guidelines

## Project Structure & Module Organization

`src/` is the NestJS API, organized by feature (`auth/`, `files/`, `payments/`, etc.). Features keep controllers, services, DTOs, entities, and unit tests together. `test/` holds HTTP end-to-end tests and fixtures. `frontend/` is a separate Next.js app: routes are in `app/`, UI in `components/`, helpers in `lib/`, and Playwright tests in `tests/`. Read `frontend/AGENTS.md` before changing frontend code. `dist/` is generated output.

## Build, Test, and Development Commands

Use Node 24 (`.nvmrc`) and install dependencies separately in the repository root and `frontend/` with `npm ci`.

- API: `npm run start:dev` starts Nest in watch mode; `npm run build` compiles to `dist/`; `npm run start:prod` runs the build.
- API checks: `npm run format:check`, `npm run lint`, `npm test -- --runInBand`, and `npm run test:e2e -- --runInBand` match the main CI gates.
- Frontend (from `frontend/`): `npm run dev` serves on port 3000; `npm run build -- --webpack` checks the production build; `npm test` runs Playwright against a running local frontend.

Give the API and frontend different ports when running both locally.

## Coding Style & Naming Conventions

Use two-space indentation and Prettier. Backend TypeScript uses single quotes and trailing commas; ESLint checks `src/**/*.ts` and `test/**/*.ts`. Name Nest files by role, such as `files.service.ts`, `files.controller.ts`, and `file-permissions.dto.ts`. Run `npm run format` in the package you changed.

## Testing Guidelines

Jest unit tests sit beside backend code as `*.spec.ts`; HTTP tests are `test/*.e2e-spec.ts`. Frontend browser tests are `frontend/tests/*.spec.js`. Add a focused test for changed behavior, especially tenant isolation, auth, billing, and file permissions. `npm run test:cov` generates backend coverage; no numeric coverage threshold is configured. Playwright uses bundled Chromium and expects the frontend at `http://localhost:3000`.

## Commit & Pull Request Guidelines

Recent commits usually use short imperative subjects with `feat:`, `fix:`, `docs:`, `ci:`, or `chore:` prefixes. Follow that pattern. In pull requests, explain the change, link any relevant issue, list checks run, and include screenshots for UI changes. CI on `main` checks backend formatting, lint, build, tests, and high-severity dependency advisories.

## Configuration & Secrets

Copy `.env.example` to an ignored `.env` for the API and `frontend/.env.example` to `frontend/.env.local` for the UI. Never commit credentials or real tokens. Keep backend secrets out of `NEXT_PUBLIC_*` variables; consult the package READMEs for required settings.
