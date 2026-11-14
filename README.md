# Forsee

An open-source, camera-based eye-tracking keyboard designed for real-time verbal communication.

Forsee is built for people who rely on eye control as their main form of interaction, with a focus on **speed**, **fluidity**, and **natural speech**. Most eye-tracking keyboards today are designed to handle writing, computer control, and speech. Forsee takes a different direction: it is **purpose-built for conversation**.

By focusing purely on conversational speech, we can optimize for faster human dialog.

## Try the new version

A rewrite (working name Forsee) lives in the TypeScript workspace (`apps/`, `packages/`, `plugins/`). Its first working version runs entirely in the browser and works offline: nothing you type or say leaves the device.

```sh
corepack enable          # Node 22; picks the pinned pnpm
pnpm install
pnpm --filter @forsee/web dev     # then open http://localhost:5173
```

To try it on an iPad or other device on the same network, see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#opening-the-app-on-other-devices).

The Mac and Windows app (`apps/desktop`) wraps the same app: `pnpm desktop` opens it. Installers are built and released by CI; see [docs/RELEASING.md](docs/RELEASING.md). The website is in `website/`.

**What works:** typing by dwell with a mouse or anything that moves the pointer (most eye trackers' mouse emulation), direct taps on touch screens, word prediction that learns your words, Speak, Stop, quick-fire replies ("Yes", "No", "Help", ...), in-place Faster/Slower dwell, pause with a deliberate wake target, a large-key two-step layout for less precise pointing, voice, rate and speak-mode settings, core plugins you can turn on and off with their own options (Settings → Plugins), and recovery of the half-written message after a reload.

**Not yet:** webcam eye tracking, the iPad and Android apps, phrase bank and history screens, the partner display, plugins from anyone other than the project. Status and the device tests still to do are in [docs/MVP_STATUS.md](docs/MVP_STATUS.md).

## Goals

- Free, open-source keyboard
- Runs anywhere: iOS, Android, Mac, Windows
- Works with software-based eye-tracking
- Natural-sounding speech output
- Open and customizable to individual needs
- **Long-term target: ~100 words per minute conversational speed**

We are absolutely **not there yet**, but this is the North Star we are aiming for.

## Project Status

The current version of Forsee is very early. It currently includes:

- Basic on-screen keyboard
- Gaze-based input via standard device camera
- Simple text-to-speech output
- Basic autocomplete suggestions
- Configurable dwell timing

It is **not yet optimized** for fast conversation or predictive phrase flow. This is the foundation that we will build on.

## How do we get to 100wpm with low-quality eye tracking

Typing letter-by-letter, or even word-by-word, is too slow. To reach conversational speed, we need sentence-level prediction. Think of it like a dialog system in a role-playing game. Instead of typing everything manually, you select from a few likely responses.

Over time, the prediction engine learns more about you. It gets to know your personality, your tone, and how it changes from one person to the next. It knows who you are talking to, what time of the day it is, where you are, and past conversations you have had. It uses that to suggest 3-4 likely full replies at once. If none of those fit, you nudge it in the right direction and it regenerates.

To be very clear, this is hard. My first cracks at building a good prediction engine have produced terrible results, have been slow, and chew through AI API credits at eye-watering rates. But this feels like a solvable problem, and something that could be quite helpful if we can pull it off.

## About privacy

To make sentence-level prediction possible, you need a lot of context. Conversations to be recorded, transcribed, and analyzed by an AI. This is why I think open-source - with the option of self-hosting - is the best solution for this project. By putting you in control of how this is run - which AI engine to use and what it has access to - you can ensure that your data isn't being used in a way that you are not comfortable with. It also opens the door to the possibility of running self-hosted local LLMs in the future.

## Who this project needs most right now

If you:
- Rely on eye-tracking daily
- Support or care for someone who does
- Work in AAC, accessibility tech, speech therapy, or UX design
- Have experience with conversation-focused communication tools
Your perspective matters more than anything, and will have a huge impact on how this project evolves.

I would love to talk to you!

- Open a discussion in GitHub
- Reach out to me directly at jeanmarc (at) empathy.works

## License

MIT
