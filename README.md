# EyeSpeak

An open-source, camera-based eye-tracking keyboard designed for real-time verbal communication.

EyeSpeak is built for people who rely on eye control as their main form of interaction, with a focus on **speed**, **fluidity**, and **natural speech**. Most eye-tracking keyboards today are designed to handle writing, computer control, and speech. Eyesight takes a different direction: it is **purpose-built for conversation**.

By focusing purely on conversational speech, we can optimize for faster human dialog.

## Goals

- Free, open-source keyboard
- Runs anywhere: iOS, Android, Mac, Windows
- Works with software-based eye-tracking
- Natural-sounding speech output
- Open and customizable to individual needs
- **Long-term target: ~100 words per minute conversational speed**

We are absolutely **not there yet**, but this is the North Star we are aiming for.

## Project Status

The current version of EyeSight is very early. It currently includes:

- Basic on-screen keyboard
- Gaze-based input via standard device camera
- Simple text-to-speech output
- Basic autocomplete suggestions
- Configurable dwell timing

It is **not yet optimized** for fast conversation or predictive phrase flow. This is the foundation that we will build on.

## Deploy to Heroku

Deploy your own instance of EyeSpeak with one click:

[![Deploy](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy?template=https://github.com/jskopek/eye-tracking-keyboard)

**Prerequisites:**
- A [Pusher](https://pusher.com/) account (free tier available)
- An [OpenAI API key](https://platform.openai.com/) (optional, for AI suggestions)

For detailed deployment instructions, see [HEROKU_DEPLOYMENT.md](HEROKU_DEPLOYMENT.md).

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
