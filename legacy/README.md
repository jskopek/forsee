# legacy

The first prototype of Forsee (version 0.1, 2025), kept for reference. It is
not maintained, not built by CI and not part of the app. The current app is
in `apps/`, `packages/` and `plugins/`; see the main [README](../README.md).

- `app/`, `conversations/`, `templates/`, `manage.py`, `pyproject.toml`,
  `.env.example`: the Django server (accounts, contacts, conversations, LLM
  reply suggestions through Groq/OpenAI, Pusher for live updates). Run from
  this folder.
- `keyboard-ui/`: the React keyboard prototype (npm, not in the pnpm
  workspace).
- `docs/`: planning notes from that period.
- `copilot-instructions.md`: AI-assistant instructions for the prototype.

The prototype's word-frequency lists (`keyboard-ui/src/autocomplete/*_subtlex.json`)
were removed: SUBTLEX-US is licensed for non-commercial use only, which does
not fit this MIT project. `keyboard-ui` autocomplete no longer builds without
them. Some of the code that moved here (for example `accounts/`,
`contacts/`) had already been deleted before the move; it is in the Git
history.
