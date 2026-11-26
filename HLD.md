# High-Level Design (HLD)

## 1. Purpose

Mini AI Study Buddy is a beginner-friendly web application for students to ask study questions, save personal notes, retrieve relevant notes while chatting, and create structured study plans. Administrators can review account totals and recorded AI usage.

This document describes the system as it currently exists in the repository. The application supports a demo mode when an OpenAI API key is not configured; live AI features require valid provider credentials.

## 2. System context

```text
Student / Administrator
          |
          | Browser: React single-page application
          |  - Vite development server, or built static assets
          v
     Express REST API  <------>  OpenAI API
          |
          +-------------------> MongoDB (Mongoose)
          |
          +-------------------> Google OAuth (optional)
```

The browser uses the same-origin `/api` routes through the Vite development proxy during development. In the production-style local setup, Express serves the built frontend and API from the same origin.

## 3. Main components

### Frontend

- React application with React Router route handling.
- Landing, authentication, student dashboard, chat, notes, planner, profile, and admin views.
- Fetch API calls to the backend; bearer JWT authentication is used for regular email/password login. OAuth also supports an HTTP-only cookie.
- Server-Sent Events (SSE) progressively deliver chat response text and completion metadata.
- Responsive styling is defined in `client/src/styles.css`.

### Backend

- Express application and REST endpoints are defined in `server.js`.
- Authentication middleware is implemented in `src/auth.js`.
- AI response generation, study-plan tools, structured output validation, and cost estimation are implemented in `src/agent.js`.
- Note embeddings and retrieval are implemented in `src/rag.js`.
- Request validation, ownership checks, rate limits, OAuth setup, and admin authorization run on the server.

### Persistence

- `src/db.js` connects to MongoDB with the required `MONGODB_URI` environment variable.
- Mongoose models in `src/models/` define users, notes, chats (with embedded messages), and usage logs.
- The server waits for the connection and model indexes before it listens; a failed connection prevents startup.
- ObjectId references and owner-scoped queries keep notes, chats, and usage associated with authenticated users.

### External services

- OpenAI Responses API supports chat, tool use, and structured study-plan output.
- OpenAI embeddings support semantic note retrieval when configured.
- Google OAuth 2.0 is optional and enabled only when its client credentials are present.

## 4. Key workflows

### Account registration and login

1. The browser submits credentials to the authentication API.
2. The backend validates the email and password, hashes new passwords with bcrypt, and stores accounts with the `student` role.
3. On successful login or registration, the backend issues an expiring signed JWT.
4. Protected API requests verify the token and load the current role from MongoDB.

Google sign-in uses Passport's OAuth state handling, verifies the email, safely links or creates an account, then issues an HTTP-only app-token cookie.

### Note creation and note-aware chat

1. An authenticated user saves a note; the backend stores it with the authenticated user's ID.
2. If OpenAI is configured, the backend generates and stores an embedding for the note.
3. When a chat question arrives, retrieval queries only the current user's notes.
4. With embeddings available, cosine similarity ranks candidate notes; otherwise, lexical word overlap provides a demo-mode fallback.
5. Relevant note content is supplied to the tutor as untrusted context. Matching note titles are returned to the browser as sources.
6. The assistant response and chat messages are persisted under the chat owner.

### Chat and study-plan generation

1. The frontend posts a question and optional conversation ID.
2. The backend checks chat ownership, retrieves notes, and invokes the AI agent.
3. The agent may call the validated `create_study_plan` function once, then asks the model to present the tool result.
4. Text deltas are streamed to the client using SSE.
5. After successful completion, the backend stores the assistant message and any available token usage and estimated cost.
6. When the API key is absent, a clearly labeled deterministic demo response is streamed instead and is not logged as paid AI usage.

The standalone planner endpoint requests a strict JSON-schema plan and validates task fields and total duration before returning it. It provides a deterministic demo plan when live AI is unavailable.

### Administrator reporting

1. Admin pages call protected admin APIs.
2. The backend checks the verified user's database role.
3. Aggregate user and usage information is queried from MongoDB and returned without password hashes.

## 5. Data model overview

```text
users 1 ---- * notes
users 1 ---- * chats 1 ---- * messages
users 1 ---- * usage_logs
```

- `users`: email, password hash (nullable for OAuth-only accounts), role, Google ID, creation time.
- `notes`: required `userId` reference, title, content, optional numeric embedding vector, timestamps.
- `chats`: required `userId` reference, title, embedded messages, creation and update times.
- `usage_logs`: user, model, input/output token counts, estimated USD cost, creation time.

The `notes.userId` and `chats.userId` indexes support user-scoped retrieval. Usage records have indexes for per-user chronological history and global recent activity. User email and Google ID are unique indexes. See [LLD.md](./LLD.md) for schema and endpoint details.

## 6. Security and reliability

- Passwords are hashed with bcryptjs and are never returned by API responses.
- JWT signatures and expiry are verified; roles are reloaded from the database rather than trusted from client input.
- New public registrations always receive the student role.
- Queries for private resources include both the resource ID and authenticated owner ID.
- Authentication, general API, and chat request rate limits are configured in the Express application.
- JSON request bodies are limited in size; common fields and IDs are validated.
- CORS uses a configured origin allowlist.
- OAuth credentials, JWT secret, OpenAI key, model names, and prices are read from environment variables.
- User questions and retrieved notes are described to the AI as untrusted data. Prompt-injection warnings are logged for some suspicious input patterns, but the system does not claim perfect prompt-injection prevention.
- Live AI failures are surfaced as errors; demo responses are explicitly labeled.

## 7. Deployment and configuration

### Development

- `npm run dev` starts Express on port 3000 and Vite on port 5173.
- Vite proxies API and OAuth requests to Express.

### Production-style local run

- `npm start` first runs the frontend build, then starts Express.
- Express serves `client/dist` and the API from port 3000 by default.

Important configuration includes `PORT`, `MONGODB_URI`, `CORS_ORIGIN`, `JWT_SECRET`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_EMBEDDING_MODEL`, token pricing, and optional Google OAuth settings. Refer to `.env.example` for the exact names.

## 8. Known design limits

- Note embeddings are stored as numeric arrays and compared in application memory; this is appropriate only for a small note collection.
- Demo retrieval uses simple lexical overlap and is not semantic search.
- Cost values are estimates based on configured prices, not provider invoices.
- OAuth requires real Google credentials and a matching callback URL.
- Prompt-injection defenses are risk-reduction measures, not a guarantee.
- The LLM evaluation script uses keyword checks and is not a complete quality or safety evaluation.
