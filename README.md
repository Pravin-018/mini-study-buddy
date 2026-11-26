# Mini AI Study Buddy

A beginner-friendly full-stack study assistant. Students can chat with a tutor, save private notes, use note-aware answers, make a study plan, and review usage. Admin-only pages show account and AI usage summaries.

The app starts without an OpenAI key. In that case, chat and planner responses are explicitly labelled **Demo response** / **Demo study plan** and do not create AI usage charges. Add an API key to enable live answers and embeddings.

## Features

- React, Vite, and React Router website with landing, login, registration, dashboard, chat, notes, planner, profile, and admin pages.
- Express REST API, MongoDB persistence through Mongoose, JWT authentication, bcrypt password hashing, and optional Google OAuth.
- Server-sent chat events, per-user chat history, note ownership checks, and private note retrieval.
- OpenAI Responses API, function calling, JSON Schema study plans, embeddings, and estimated token costs.
- Mock/demo behavior when the AI key is absent, plus built-in Node.js tests and a small LLM evaluation set.

## Technology

- Frontend: React 18, Vite, React Router, Fetch API, CSS.
- Backend: Node.js, Express, Passport Google OAuth, and Mongoose.
- Database: MongoDB, configured through `MONGODB_URI`.
- AI: OpenAI Responses and embedding APIs.
- Tests: Node.js built-in test runner and a keyword-based LLM evaluation script.

## Project structure

```text
HLD.md
LLD.md
PRD.md
client/
  index.html
  src/
    App.jsx
    main.jsx
    styles.css
server.js
src/
  agent.js
  agent.test.js
  auth.js
  db.js
  models/
    User.js
    Note.js
    Chat.js
    UsageLog.js
  models.test.js
  rag.js
  server.test.js
prompts/
  tutor.md
evals/
  cases.json
  run-evals.js
package.json
vite.config.js
.env.example
```

The design and product documents are [PRD.md](./PRD.md) (requirements), [HLD.md](./HLD.md) (system architecture), and [LLD.md](./LLD.md) (implementation details and API contracts).

## Prerequisites and setup

- Node.js 20.19 or later and npm.
- A local MongoDB instance or MongoDB Atlas database.
- OpenAI API key only for live AI functionality. Demo mode works without one.

From the project root:

```bash
npm install
```

For local configuration, copy `.env.example` to `.env` and edit the values:

```dotenv
PORT=3000
MONGODB_URI=mongodb://127.0.0.1:27017/mini-study-buddy
CORS_ORIGIN=http://localhost:5173,http://localhost:3000
JWT_SECRET=use-a-unique-random-value-at-least-32-characters-long
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_INPUT_COST_PER_1M=0.15
OPENAI_OUTPUT_COST_PER_1M=0.6
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback
```

`JWT_SECRET` must be at least 32 characters. If it is omitted, the server generates a secure temporary key and warns that sessions will stop working after a restart. Never commit `.env` or use example values as production credentials.

`MONGODB_URI` is required. For local development, start MongoDB and use the local URI above. For MongoDB Atlas, create a database user, allow your machine's IP in Network Access, and put the Atlas connection string (including a database name) in `MONGODB_URI`. URL-encode special characters in the connection-string password. Keep the real URI only in your ignored `.env`.

`CORS_ORIGIN` is a comma-separated allowlist. Add the exact origin that serves your hosted frontend before deployment.

The token prices are configurable illustrative USD rates per million tokens. Update them to match your current model pricing. Displayed cost is an estimate, not an exact charge.

## Run the app

### Development

```bash
npm run dev
```

This starts the Express API at `http://localhost:3000` and Vite at `http://localhost:5173`. Open **http://localhost:5173**. The frontend proxies API and OAuth requests to Express.

### Production-style local run

```bash
npm start
```

The `prestart` script builds the React app, then Express serves it at **http://localhost:3000**.

The application connects to MongoDB before listening and creates schema indexes through Mongoose. If MongoDB is unavailable or `MONGODB_URI` is missing, startup fails with an explicit error. The old ignored `study-buddy.db` file is not read or modified; existing SQLite records are not automatically imported.

## How to use

1. Create an account or log in.
2. Open **My notes** to save study material. Without an OpenAI key, notes are saved and basic word-overlap retrieval is used; live embedding retrieval activates when a key is configured.
3. Start a chat and ask a question. Relevant private note titles appear with the answer when found.
4. Open **Study planner**, choose a topic, difficulty, and available time, and generate a checklist.
5. Use **Profile** to see your own real AI usage records and log out.

When `OPENAI_API_KEY` is empty, the site still supports registration, login, notes, chat history, navigation, and deterministic study plans. AI answers and plans are marked as demo output. No usage is logged for demo responses.

## Google OAuth (optional)

1. In Google Cloud Console, configure an OAuth consent screen and create a Web application OAuth client.
2. Add `http://localhost:3000/auth/google/callback` as an authorized redirect URI (or set a matching `GOOGLE_CALLBACK_URL`).
3. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_CALLBACK_URL` in `.env`.
4. Restart the server. The OAuth flow uses Passport's state check and a short-lived server-side session; the resulting app JWT is delivered in an HTTP-only cookie.

Google login is optional. If credentials are absent, the rest of the app works normally and the Google login route responds that it is not configured.

## Create a local admin account

1. Register using the regular registration page. Public registration always assigns the `student` role.
2. Use `mongosh` with the same MongoDB database configured in `.env` and run:

   ```javascript
   db.users.updateOne({ email: 'you@example.com' }, { $set: { role: 'admin' } });
   ```

3. The API reloads the role from MongoDB on each request; refresh the application.

Never expose an admin-promotion operation through public registration or an unauthenticated API.

## API overview

- `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- `GET /api/notes`, `GET /api/notes/:id`, `POST /api/notes`, `PUT`/`PATCH /api/notes/:id`, `DELETE /api/notes/:id`
- `POST /api/chat` (SSE), `GET /api/chats`, `GET /api/chats/:id`, `DELETE /api/chats/:id`
- `POST /api/study-plan`, `GET /api/usage`
- Admin protected: `GET /api/admin/stats`, `/api/admin/users`, `/api/admin/usage`
- Optional OAuth: `GET /auth/google`, `GET /auth/google/callback`

Authentication uses a bearer JWT (or the HTTP-only OAuth cookie). Ownership is enforced in the API using the authenticated MongoDB user; frontend-supplied IDs or role claims are not authorization. Notes reference users through `userId`; chat messages are embedded in their owning chat; usage records reference users.

## Tests and evaluations

Run the test suite:

```bash
npm test
```

It includes unit tests for demo plans, retrieval scoping, vector embeddings, and cost estimates, plus API integration tests against an ephemeral MongoDB server for registration validation, protected/admin endpoints, note CRUD and ownership, SSE demo chat, and the planner fallback.

Run the LLM evaluation set when an OpenAI key is available:

```bash
npm run eval
```

The five cases in `evals/cases.json` use expected keywords. This is only a basic starting point: keyword checks do not establish correctness, usefulness, safety, or consistency. Evaluation calls use the configured model and may incur provider charges. The script reports that the key is required if it is missing.

Build the frontend:

```bash
npm run build
```

## Rubric concept checklist

| # | Concept | Implementation |
|---|---|---|
| 1 | Function calling / tool use | `src/agent.js` defines strict `create_study_plan` and validates arguments before executing the backend tool. |
| 2 | LLM API integration | `server.js`, `src/agent.js`, and `src/rag.js` use OpenAI with environment-configured models and API key. |
| 3 | LLM evaluation sets | `evals/cases.json`, `evals/run-evals.js`; five beginner study cases and explicitly basic keyword evaluation. |
| 4 | Multi-step agent | `src/agent.js` decides whether to use a plan tool, validates/executes it, and streams a follow-up response with an iteration limit of one tool call. |
| 5 | Prompt engineering | `prompts/tutor.md`, loaded by `src/agent.js`; asks for beginner-friendly, concise explanations and examples. |
| 6 | Prompt injection awareness and defenses | `prompts/tutor.md`, `src/agent.js`, and `server.js`; untrusted input and notes are marked as data, tool input is validated, and sensitive operations remain server-side. These defenses are not perfect. |
| 7 | RAG: embeddings and retrieval | `src/rag.js`; numeric embedding vectors are saved in MongoDB, cosine similarity ranks notes, fallback lexical matching works without a key, and queries are owner-scoped. |
| 8 | Streaming responses | `server.js` emits SSE; `client/src/App.jsx` reads and progressively displays events, errors, sources, and completion. |
| 9 | Structured outputs | `src/agent.js` requests a strict JSON Schema plan and validates task fields and total duration before returning it. |
| 10 | Token and cost monitoring | `src/agent.js` reads provider usage and estimates cost; `server.js` persists per-user records; dashboard and admin pages display estimates. |
| 11 | Input validation and database safety | `server.js` validates email, text, durations, and MongoDB ObjectIds; Mongoose schemas validate persisted data and API errors are explicit. |
| 12 | JWT issuance and verification | `server.js` issues expiring JWTs; `src/auth.js` verifies them and reloads user role from MongoDB. |
| 13 | OAuth / third-party login | `server.js` optionally configures Google OAuth with environment secrets, Passport state checking, verified email, and HTTP-only JWT cookie. |
| 14 | Password hashing | `server.js` hashes passwords with bcryptjs cost factor 12 and never returns hashes. |
| 15 | Rate limiting | `server.js` applies general API, auth-attempt, and chat request limits plus a JSON body-size limit. |
| 16 | Role-based authorization | `src/auth.js` provides reusable authentication/admin middleware; `server.js` protects all admin APIs and defaults new users to student. |

## Limitations and security notes

- This is a learning project, not a production-ready service. Use HTTPS, secure secrets, configure allowed CORS origins, monitor provider costs, and add operational logging and backups before deployment.
- Rate limits are IP-based; production deployments behind proxies need a carefully configured Express `trust proxy`.
- Prompt injection defenses reduce risk but cannot guarantee that a model will ignore adversarial content.
- Demo-mode retrieval is simple word overlap, not semantic search. Live embedding/API failures are surfaced rather than silently described as AI success.
- Cost calculations depend on manually configured rates and are estimates. Demo requests are not represented as paid AI usage.
- Google OAuth needs real credentials and an externally reachable callback for hosted deployment.
#   m i n i - s t u d y - b u d d y  
 