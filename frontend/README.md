# Sovereign AI Workbench — Frontend

A static single-page application. It builds to a folder of files that FastAPI
or nginx serves directly, with no Node runtime in production — the product
ships into air-gapped facilities, and one fewer thing to install and patch
there is worth more than server-side rendering.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173, API proxied to 127.0.0.1:8000
```

The backend must be running:

```bash
cd ../backend && .venv/Scripts/python -m uvicorn app.main:app --reload
```

`/api`, `/health` and `/internal` are proxied in development, so the app is
same-origin in both environments and there is no base URL to get wrong.
Point the proxy elsewhere with `VITE_API_TARGET`.

## Checks

```bash
npm test           # Vitest + React Testing Library
npm run typecheck
npm run build
```

### Against a running backend

The unit tests mock `fetch`, which verifies the screens against the shapes this
codebase *believes* the API returns — the one assumption that can be wrong. A
second suite removes the mock, signs in for real and renders every screen
against a live API:

```bash
# with the backend running on 127.0.0.1:8000
LIVE_API=http://127.0.0.1:8000 npm test -- live-integration
```

It skips entirely without `LIVE_API`, so the ordinary suite still needs
nothing running. `LIVE_EMAIL` and `LIVE_PASSWORD` override the demo account.
The tests that need particular data — a task to trace, a run that cited a
source — report as skipped rather than passing when the backend has none, so a
green run means the checks actually ran.

In production the built `dist/` is served by the API itself, so there is no
second server and no base URL to configure:

```bash
npm run build      # then http://127.0.0.1:8000/ serves this app
```

The Playwright hero flow (`npm run test:e2e`) also needs a live backend, plus
`E2E_EMAIL` / `E2E_PASSWORD` and `playwright install chromium`.

## What is here

All five parts: the design system and shell, the landing page, the workbench
and task views, documents / knowledge / artifacts, and the security, model and
settings screens.

```
src/
├── lib/          api client, auth, types, formatters, SSE, pipeline reducer
├── components/
│   ├── ui/       button, input, card, dialog, table, status pills
│   ├── shell/    sidebar, header, sovereignty badge, chat history
│   ├── states/   empty, loading, error, no-access, oversight note
│   └── …         workbench, dashboard, documents, access, profile panels
└── pages/        landing, login, dashboard, workbench, tasks and traces,
                  documents and viewer, knowledge, artifacts, approvals,
                  coding, security, models, profile, settings
```

There is no theme module: the app is dark only, a control-room instrument
panel, and the palette lives in `styles/globals.css`.

## Two decisions worth knowing

**The session token lives in `sessionStorage`, not `localStorage`.** This runs
on shared industrial workstations, and a token in `localStorage` outlives the
browser session for whoever sits down next.

**Permissions decide what is *shown*, never what is *allowed*.** The backend
re-checks every call. A hidden button is a convenience; every screen still has
to render a 403 arriving as a stated boundary rather than a crash.
