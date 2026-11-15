# Next Steps to Revive the Project

The project was last touched on **Dec 6, 2025** (branch `plugins`). This file records what we found when checking it again in October 2026, and what needs to happen to get it running.

## Where things stand

### Still working
- **Python backend.** The Poetry virtualenv (Python 3.11) is intact, the lockfile is valid, `manage.py check` passes (only a warning that `static/` is missing) and there are no pending migrations. `runserver` starts and serves `/` and `/list/`.
- **React frontend** (`keyboard-ui/`). `npm run build` compiles, with lint warnings only.
- **Credentials.** The Groq API key in `.env` is valid. The Pusher credentials in `.env` work: a test `trigger` succeeded.
- **Voice transcription.** `whisper-large-v3` is still available on Groq.

### Broken
- **The LLM model has been retired.** `GROQ_MODEL` defaults to `llama-3.1-8b-instant` (`app/settings.py`), which Groq no longer serves (`404 model_not_found`). Every suggestion and hint request fails.
- **The Django-served keyboard page can't load React.** `conversations/templates/conversations/keyboard.html` loads `{% static 'keyboard-ui/static/js/main.js' %}` and gets a 404. CRA builds hashed filenames (for example `main.29aa14a3.js`), and the `static/` directory listed in `STATICFILES_DIRS` doesn't exist.

## To-do list

### 1. ✅ Switch to a model Groq still serves
Done (Oct 2026): `GROQ_MODEL` now defaults to `openai/gpt-oss-20b` in `app/settings.py`. You can still override it in `.env`.

Current Groq chat models that support tool calling include `openai/gpt-oss-20b`, `openai/gpt-oss-120b` and `qwen/qwen3.6-27b`. In a streaming tool-call test, `gpt-oss-20b` and `qwen3.6-27b` returned their first tool call in about 0.5s.

### 2. Get several suggestions per request again
The Suggestions plugin expects the model to call `push_suggestion` several times in one response. In a test, both `gpt-oss-20b` and `qwen3.6-27b` made only **one** tool call per turn. Options:
- Rework the prompt so it asks for multiple calls more explicitly, and check whether Groq's `parallel_tool_calls` setting helps.
- Switch to a single tool call that returns an array of suggestions.
- Loop on the server until N suggestions have been collected.

The hints prompts in `HintsPlugin.js` and `conversations/utils_prompt_groq.py` probably need the same check.

### 3. Pick one way to serve the frontend
- **Development (quickest):** run Django on `:8000` and `npm start` in `keyboard-ui/` on `:3000`. CORS already allows `REACT_DEV_SERVER_URL` (default `http://localhost:3000`), and `keyboard-ui/src/utils/apiBaseUrl.js` falls back to `http://localhost:8000` in development. This path hasn't been checked in a browser yet.
- **Django-served:** copy or point `keyboard-ui/build` into a static directory Django serves, and stop hard-coding `main.js`. You can read the hashed name from `build/asset-manifest.json`, or turn off filename hashing.

### 4. ✅ Commit the uncommitted work on `plugins`
Done (Oct 2026): the Dec 2025 work in progress was committed, and `main` was fast-forwarded to `plugins`.

Still open: consider deleting the leftover files `keyboard-ui/src/App-old.js` and `keyboard-ui/src/App-with-plugins.js`.

### 5. Clean up the frontend lint warnings
These are what make `CI=true npm run build` fail:
- `src/App.js:253`: unnecessary `useCallback` dependencies (`startVoiceRecording`, `stopVoiceRecording`)
- `src/hooks/useLLM.ts:141`: unused `result`
- `src/hooks/useVoiceRecorder.js:69,177`: missing `isMutedRef` dependency
- `src/plugins/HintsPlugin.js:94`: missing `context` dependency

It's also worth running `npx update-browserslist-db@latest`, because the caniuse data is about 12 months old.

### 6. Make it runnable for anyone besides me
- ✅ `shellviz` (LLM stream logging) is no longer a dependency, and `conversations/api_llm.py` falls back to a no-op when it isn't installed. To use it, check out the shellviz repo and run `poetry run pip install -e <path-to-shellviz>/libraries/python`.
- `.env.example` is missing `GROQ_API_KEY`, `GROQ_MODEL`, `PUSHER_*`, `CORS_ALLOWED_ORIGINS` and `CSRF_TRUSTED_ORIGINS`. `keyboard-ui/` also needs an example `.env` with `REACT_APP_PUSHER_KEY` and `REACT_APP_PUSHER_CLUSTER`.
- The README has no setup or run instructions.

## Related folders in `~/code`
- `~/code/eye-tracking-keyboard`: another clone of the same GitHub repo (`jskopek/eye-tracking-keyboard`), on `main`, 5 commits behind this one. Its only unique content is an uncommitted switch from Poetry to `uv` (`uv.lock`, `.python-version`, and edits to `pyproject.toml` and `.gitignore`). Keep that if it's useful, then delete the clone.
- `~/code/eye-tracking-keyboard-v1`: the original April 2024 prototype (OpenAI/GPT-4, deployed on Heroku). It's a separate codebase and for reference only.

## Quick start
```bash
# Copy .env (repo root) and keyboard-ui/.env over from the old machine first;
# they're gitignored. Copy db.sqlite3 too if you want the old conversations.

# Backend
poetry install
poetry run python manage.py migrate
poetry run python manage.py runserver        # http://localhost:8000

# Frontend (in another terminal)
cd keyboard-ui
npm install
npm start                                    # http://localhost:3000
```
