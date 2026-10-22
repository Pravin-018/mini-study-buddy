# Low-Level Design (LLD)

## 1. Scope

This document describes the current implementation-level design of Mini AI Study Buddy. The application is a JavaScript ES-module project with a React/Vite frontend, an Express API, a SQLite database, and optional OpenAI and Google OAuth integrations.

## 2. Source module responsibilities

| File | Responsibility |
|---|---|
| `server.js` | Express setup, SQLite schema and migrations, CORS/body limits, rate limiting, authentication and OAuth routes, application APIs, SSE, static frontend hosting, and error handling. |
| `src/auth.js` | JWT/cookie authentication middleware and database-backed admin-role enforcement. |
| `src/agent.js` | OpenAI Responses API calls, `create_study_plan` function definition and argument validation, structured planner output validation, streaming text, token extraction, and cost estimation. |
| `src/rag.js` | Note embedding generation, user-scoped note selection, cosine similarity, and lexical fallback retrieval. |
| `client/src/App.jsx` | Authentication context, API helper, route guards, page and form behavior, chat SSE consumption, notes and planner workflows, and admin displays. |
| `client/src/styles.css` | Application layout, theme, responsive behavior, and component styling. |
| `client/src/main.jsx` | React application entry point. |
| `prompts/tutor.md` | Tutor behavior instructions, beginner-friendly response guidance, and treatment of untrusted questions and notes. |
| `evals/cases.json` | Five study-question evaluation examples and expected keywords. |
| `evals/run-evals.js` | Runs keyword-based checks against the configured OpenAI model. |
| `src/agent.test.js` | Unit coverage for demo planning, validation, streamed demo answers, retrieval ownership, and cost estimates. |
| `src/server.test.js` | API integration coverage for auth, authorization, migration, note/chat ownership, SSE demo chat, and planner behavior. |

## 3. HTTP API

All JSON errors use the shape `{ "error": "..." }`. Protected endpoints require a valid bearer JWT or the OAuth `study_buddy_token` cookie. Identifiers in path parameters must be positive safe integers.

### Authentication and status

| Method and path | Auth | Behavior |
|---|---|---|
| `GET /api/status` | Public | Returns whether live AI is configured and the selected model. |
| `POST /api/auth/register` | Public | Validates email and password, hashes password, creates a student account, and returns a token and public user. |
| `POST /api/auth/login` | Public | Checks credentials and returns a token and public user; invalid credentials use a generic error. |
| `GET /api/auth/me` | Required | Returns the authenticated public user. |
| `POST /api/auth/logout` | Public | Clears the OAuth token cookie. Clients using bearer tokens remove their local token. |
| `GET /auth/google` | Public, optional | Starts Google OAuth when configured; otherwise returns an unavailable response. |
| `GET /auth/google/callback` | OAuth callback | Verifies OAuth result, links or creates an account, sets the HTTP-only app-token cookie, and redirects. |

### Notes

| Method and path | Auth | Behavior |
|---|---|---|
| `GET /api/notes` | Required | Lists only the current user's notes. |
| `POST /api/notes` | Required | Requires a nonempty title (maximum 120 characters) and content (maximum 8,000 characters); optionally generates an embedding. |
| `DELETE /api/notes/:id` | Required | Deletes only a note owned by the current user; returns 404 if it is not owned or does not exist. |

### Chats

| Method and path | Auth | Behavior |
|---|---|---|
| `POST /api/chat` | Required | Accepts a question (maximum 2,000 characters) and optional owned `chatId`; streams SSE text, note sources, and completion metadata. |
| `GET /api/chats` | Required | Lists the current user's chat summaries and latest messages. |
| `GET /api/chats/:id` | Required | Returns one owned chat and its ordered messages. |
| `DELETE /api/chats/:id` | Required | Deletes only an owned chat; related messages are removed by the foreign key cascade. |

SSE text events use `data: {"text":"..."}`. The terminal success event is `event: done` and includes the chat ID, matching note titles, demo flag, and available usage. Errors after the stream starts are sent as `event: error`.

### Planner, usage, and administration

| Method and path | Auth | Behavior |
|---|---|---|
| `POST /api/study-plan` | Required | Requires a nonempty topic (maximum 160 characters), 5–480 minutes, and difficulty `beginner`, `intermediate`, or `advanced`; returns a validated plan. |
| `GET /api/usage` | Required | Returns usage aggregates and up to 20 recent records for the current user. |
| `GET /api/admin/stats` | Admin | Returns user count, AI request count, token total, and estimated cost. |
| `GET /api/admin/users` | Admin | Returns up to 200 user summaries and per-user AI request counts. |
| `GET /api/admin/usage` | Admin | Returns up to 100 recent usage records with account email. |

## 4. Database schema

The schema is initialized in `server.js`; SQLite foreign-key enforcement is enabled.

```sql
users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'student'
    CHECK(role IN ('student', 'admin')),
  google_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)

notes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)

chats (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)

messages (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)

usage_logs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)
```

Indexes are created for `notes.user_id`, `chats.user_id`, `messages.chat_id`, and `usage_logs.user_id`. Startup compatibility logic adds selected missing legacy columns and migrates an older `usage` table once. Notes without an owner are not returned to authenticated users.

## 5. Authentication and authorization details

- Registration accepts an email and password; password length is at least 8 characters and at most 72 UTF-8 bytes to match bcrypt's input limit.
- Password hashes use bcryptjs with work factor 12.
- JWTs contain the user ID and expire after two hours.
- `requireAuth` accepts the `Authorization: Bearer <token>` header or OAuth cookie, verifies the JWT, then reads `id`, `email`, and `role` from the database.
- `requireAdmin` allows the request only when the loaded database role is `admin`.
- New accounts are assigned `student` regardless of submitted role fields.
- Notes and chats are retrieved, deleted, and updated using both the resource ID and authenticated user ID.
- Admin promotion is a local database operation described in `README.md`; no public promotion endpoint exists.

## 6. AI and retrieval details

### Chat agent

1. Load tutor instructions from `prompts/tutor.md`.
2. Send the question and retrieved notes, clearly marked as untrusted data, to the configured Responses API model.
3. Permit the strict `create_study_plan` function tool.
4. If the model requests a tool, accept only one supported call, parse its JSON arguments, and validate topic, minutes (5–480), and difficulty.
5. Execute the backend plan tool and submit its result for a final streamed answer.
6. If no tool is requested, stream a normal tutor response.
7. Add token counts from the decision and final responses where present.

The workflow executes at most one function call per user question; it does not recursively execute model-requested tools.

### Standalone structured plan

The planner requests a strict JSON-schema object with `topic` and `tasks`. Each task must have a name, positive integer minute count, and description. The backend rejects empty, oversized, malformed, or duration-mismatched plans before returning them.

### Retrieval

- Notes are selected with `WHERE user_id = ?`.
- When live embeddings are available, note and query vectors are compared using cosine similarity; up to three results above the similarity threshold are selected.
- Notes without embeddings use lexical scoring.
- Without a configured OpenAI client, all candidates use simple lexical overlap and only positive matches are returned.
- Retrieved note content is input context only; it cannot authorize API operations or bypass server-side checks.

### Usage estimates

Usage is recorded for completed live AI chat and planner responses when token usage is provided. Demo output is not recorded as paid AI activity. Cost is computed from `OPENAI_INPUT_COST_PER_1M` and `OPENAI_OUTPUT_COST_PER_1M` and is an estimate.

## 7. Validation, errors, and limits

- Express JSON request body limit: 20 KB.
- General API limiter: 60 requests per minute per IP.
- Authentication limiter: 20 requests per 15 minutes per IP.
- Chat limiter: 12 requests per minute per IP.
- Email, password, text fields, difficulty, numeric ranges, and resource IDs are validated before use.
- SQL uses parameter placeholders for user-provided values.
- Provider failures are logged server-side and returned as explicit API or SSE errors.
- Aborted/disconnected chat requests cancel the provider request when supported by the SDK.
- CORS origins are restricted to `CORS_ORIGIN` (or the local development defaults).

## 8. Frontend routes

| Route | Access | View |
|---|---|---|
| `/` | Public | Landing page |
| `/login` | Public | Login form |
| `/register` | Public | Registration form |
| `/app` | Authenticated | Student dashboard |
| `/app/chat` | Authenticated | New chat |
| `/app/chat/:chatId` | Authenticated | Existing owned chat |
| `/app/notes` | Authenticated | Note collection and editor |
| `/app/planner` | Authenticated | Study-plan form and checklist |
| `/app/profile` | Authenticated | Profile and personal usage |
| `/admin` | Admin | Admin overview, user table, and usage records |

The route guard improves navigation but is not an authorization boundary; server middleware enforces access for protected data.

## 9. Configuration and commands

- `.env.example` documents configuration for the API port, CORS origins, JWT signing secret, OpenAI models and API key, token rates, and Google OAuth.
- Development: `npm run dev`.
- Production-style local run: `npm start` (builds the frontend first).
- Frontend build: `npm run build`.
- Tests: `npm test`.
- LLM evaluation: `npm run eval` (requires `OPENAI_API_KEY` and may incur provider cost).
