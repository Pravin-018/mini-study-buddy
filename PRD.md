# Product Requirements Document (PRD)

## 1. Product overview

**Product:** Mini AI Study Buddy  
**Audience:** Students who want a simple place to ask study questions, organize notes, and plan focused study sessions.  
**Product type:** Responsive web application with an optional AI provider integration.

Mini AI Study Buddy combines a conversational tutor, private notes, note-aware question answering, and a study planner. It also provides basic usage visibility and a restricted administrator dashboard.

## 2. Problem statement

Students often switch between notes, question-answer tools, and planning tools while studying. This project brings these basic activities into one approachable interface and makes saved notes available as context for relevant answers.

## 3. Goals

- Provide an easy-to-understand study assistant that a student can demonstrate and explain.
- Allow students to create accounts and keep their notes, chats, and usage private.
- Make it possible to explore the core application without an OpenAI API key.
- Clearly distinguish live AI output from deterministic demo output.
- Demonstrate LLM integration, RAG, streaming, tool use, structured output, and basic evaluation.
- Give administrators protected visibility into account and recorded live AI usage totals.

## 4. Non-goals

- Replacing a learning management system, school portal, or professional tutoring service.
- Guaranteed factual correctness, grading, or citations to external sources.
- Production-scale multi-region hosting, high-availability operation, or large-scale vector search.
- A complete billing or provider-invoice reconciliation system.
- Perfect prevention of prompt injection or other model failure modes.
- Public self-service account-role changes.

## 5. User roles

### Student

- Registers or signs in with email/password; optionally uses Google sign-in when configured.
- Uses a personal dashboard, chats, notes, planner, and profile.
- Can access only their own private notes, conversations, and usage information.

### Administrator

- Is an authenticated user whose role is set through a trusted local database operation.
- Can view aggregate user and AI usage statistics, a bounded users list, and recent usage records.
- Cannot be granted the role through public registration input.

## 6. User journeys

### First-time student

1. Visits the landing page and selects **Get started**.
2. Registers with email and password.
3. Lands in the student dashboard.
4. Saves a study note or starts a new chat.
5. Sees demo output when no OpenAI API key is configured, or live AI output when configured.

### Note-based learning

1. Saves a titled note in **My Notes**.
2. Opens chat and asks a question related to that material.
3. The application retrieves matching notes belonging to that account.
4. The answer streams into the conversation and displays source note titles when matches are found.

### Study planning

1. Opens **Study Planner**.
2. Enters a topic, available minutes, and difficulty.
3. Receives a checklist of timed tasks whose durations add up to the requested session length.
4. Checks off tasks while studying.

### Administrator reporting

1. An administrator signs in.
2. Opens the admin dashboard.
3. Reviews totals and recent records returned by protected admin endpoints.

## 7. Functional requirements and acceptance criteria

### Accounts and access

- **FR-01 Registration:** A user can register with a valid email and password of at least 8 characters. Invalid input is rejected with an understandable message.
- **FR-02 Default role:** Every public registration creates a student account regardless of any submitted role value.
- **FR-03 Login:** A user can log in; invalid credentials receive a generic authentication error.
- **FR-04 Session verification:** Protected API requests require a valid, unexpired JWT or the OAuth cookie.
- **FR-05 Optional Google login:** OAuth is available only when credentials are configured; missing credentials do not prevent the rest of the application from running.
- **FR-06 Logout:** The user can log out of the browser application; OAuth cookies are cleared by the backend.

### Student study tools

- **FR-07 Dashboard:** The dashboard presents navigation, recent conversations, saved-note count, and real usage totals where available.
- **FR-08 Chat:** A signed-in student can create a conversation, submit questions, see a progressively streamed answer, and revisit persisted chat history.
- **FR-09 Chat feedback:** Loading state, provider errors, and demo-mode output are visibly communicated.
- **FR-10 Note management:** A student can create, list, and delete their own notes.
- **FR-11 Private retrieval:** Chat retrieval considers only notes owned by the current student and reports relevant note titles in the UI.
- **FR-12 Retrieval fallback:** If embeddings are unavailable, the application uses lexical matching; if no relevant note is found, the tutor is told that no matching notes were found.
- **FR-13 Study planner:** A student can request a plan for a topic, duration, and difficulty. The response has named tasks, descriptions, and valid durations summing to the requested time.
- **FR-14 Profile and usage:** A student can see account details and usage records belonging only to that student.

### Administration

- **FR-15 Admin dashboard:** An administrator can view total users, AI requests, tokens, estimated cost, recent usage, and user summaries.
- **FR-16 Server authorization:** Student requests to admin APIs are rejected by backend authorization, even if a user navigates directly to the admin URL.

### AI behavior and evaluation

- **FR-17 AI provider configuration:** The OpenAI API key and model names are environment-configured and never embedded in frontend code.
- **FR-18 Demo mode:** The application starts without an OpenAI key; demo answers and plans are clearly labeled and not represented as paid AI usage.
- **FR-19 Tool use:** The chat agent can request one validated `create_study_plan` function call and use its result in the final answer.
- **FR-20 Structured output:** Standalone study plans use a strict schema and are validated before display.
- **FR-21 Prompt instructions:** The tutor is instructed to teach in beginner-friendly language and treat questions and retrieved notes as untrusted data.
- **FR-22 LLM evaluation:** A small JSON question set can be run against the configured model; results are explicitly described as basic keyword checks.
- **FR-23 Usage estimates:** Live AI usage is stored when the provider returns token counts; cost is labeled as an estimate.

## 8. User experience requirements

- Calm, readable interface with light backgrounds and purple/blue accents.
- Responsive behavior for desktop and mobile layouts.
- Navigation is consistent across authenticated application pages.
- Forms display actionable validation and request errors.
- Notes and chats have clear empty states.
- No important control is purely decorative; save, delete, send, plan, checklist, navigation, and logout actions have real behavior.
- When live AI is not configured, the UI makes demo behavior clear.

## 9. Security and privacy requirements

- Passwords are stored only as bcrypt hashes.
- API access is authenticated and roles are determined server-side.
- Private notes, chats, and usage are always scoped to the authenticated account.
- Database queries use parameterized SQL for user input.
- Inputs and IDs are validated; request bodies and request rates are bounded.
- OAuth credentials, AI keys, and JWT signing secret are environment configuration, not client-side assets.
- Questions and retrieved notes are untrusted content; prompt-injection defenses are risk reduction, not a security guarantee.
- AI-generated text must not be treated as guaranteed accurate or as a substitute for authoritative course material.

## 10. Non-functional requirements

- **Usability:** A beginner should be able to install, run, and demonstrate the application using the README.
- **Reliability:** Invalid AI responses are rejected by validation; failures are shown rather than disguised as successful live output.
- **Performance:** Chat output is streamed to reduce perceived wait time. SQLite and in-memory embedding comparisons are intended for small datasets.
- **Maintainability:** Backend AI, retrieval, and authentication logic is separated into focused modules; the React UI currently resides primarily in `client/src/App.jsx`.
- **Configurability:** Port, CORS origins, secrets, model names, OAuth credentials, and price estimates can be configured through environment variables.
- **Testability:** The project uses Node.js's built-in test runner and supports a separate LLM evaluation command.

## 11. Success measures

The project is considered functionally successful when:

- A new student can register, log in, create notes, create chats, and generate a plan.
- A user cannot read or delete another user's notes or chats.
- Anonymous requests cannot access protected APIs, and students cannot access admin APIs.
- Chat streams and persists a completed demo response when no AI key exists.
- Live mode records returned token usage and estimated cost when provider usage is available.
- The frontend builds and the automated tests pass.

## 12. Dependencies and configuration

- Node.js 22.5 or later and npm.
- OpenAI API key for live chat, embeddings, structured AI plans, and LLM evaluations; optional for demo operation.
- Google OAuth client ID and secret only if Google sign-in is desired.
- A strong `JWT_SECRET` for stable local sessions; see `.env.example` for all supported variables.

## 13. Known limitations

- This is a learning project and is not production-ready without deployment hardening, monitoring, backups, and operational controls.
- AI answers may be inaccurate. Prompt-injection defenses are not guaranteed.
- Demo answers are illustrative and are not generated by an LLM.
- Lexical demo retrieval is a simple fallback, not semantic search.
- Usage cost is estimated using configured token prices and may differ from actual provider charges.
- Google OAuth and real AI integration cannot be fully verified without valid external credentials.
- The keyword evaluation set checks only expected terms and cannot establish answer correctness or safety.

## 14. Requirement-to-implementation traceability

| Requirement area | Primary implementation |
|---|---|
| React pages, routes, and interactions | `client/src/App.jsx`, `client/src/styles.css` |
| API, persistence, auth endpoints, admin APIs | `server.js` |
| JWT and role middleware | `src/auth.js` |
| AI agent, tool use, structured plans, usage estimate | `src/agent.js` |
| Embeddings and note retrieval | `src/rag.js` |
| Tutor instructions | `prompts/tutor.md` |
| Evaluation cases and runner | `evals/cases.json`, `evals/run-evals.js` |
| Unit and integration tests | `src/agent.test.js`, `src/server.test.js` |
| Setup, configuration, and local admin guidance | `README.md`, `.env.example` |
