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

## What is here

Part 01 of five: the project, the design tokens, the API client, auth and the
role context, and the application shell. Screens for Parts 02–05 are routed
and render a placeholder naming the part they arrive in — an unfinished screen
and an empty one look identical otherwise.

```
src/
├── lib/          api client, auth, theme, types, formatters
├── components/
│   ├── ui/       button, input, card, status pills
│   ├── shell/    sidebar, header, sovereignty badge
│   └── states/   empty, loading, error
└── pages/        login, signup, workspaces, dashboard
```

## Two decisions worth knowing

**The session token lives in `sessionStorage`, not `localStorage`.** This runs
on shared industrial workstations, and a token in `localStorage` outlives the
browser session for whoever sits down next.

**Permissions decide what is *shown*, never what is *allowed*.** The backend
re-checks every call. A hidden button is a convenience; every screen still has
to render a 403 arriving as a stated boundary rather than a crash.
