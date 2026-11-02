# How Rudder works

Rudder is a Firefox extension that decides which YouTube recommendations you see. It checks every video on the home page, the watch page's sidebar, search results, channel pages and the Shorts viewer **before the page shows it**, and removes the ones you don't want.

Three promises shape everything below:

- **You never see a video before it's checked.** Every video starts invisible and only appears once it has passed.
- **Everything happens on your computer.** Rudder sends nothing anywhere and makes no requests to YouTube of its own. It only reads what YouTube already sends your browser.
- **When in doubt, hide.** A check that fails, times out or can't decide keeps the video hidden.

## The journey of one video

```
YouTube sends the page its data ──▶ Rudder reads it ──▶ the pipeline decides ──▶ the page shows it, or removes it
   (titles, channels,                (one record per      (stages, in order:      (in order, with no holes,
    thumbnails)                       video)               hide / show / pass)     the feed topped back up)
```

### 1. Reading YouTube

Rudder never asks YouTube for anything. It reads three things the page receives anyway:

- **The page's own data.** A small page script (`extension/youtube/page.js`) reads the data YouTube puts in the page when it first loads.
- **YouTube's responses as you browse.** The background page reads the responses for more home videos, the watch page's sidebar, search results and the Shorts viewer as they arrive, passing every byte on unchanged (`extension/youtube/intercept.js`).
- **Thumbnails.** The image bytes of every thumbnail the page downloads, read on their way to the page.

From these, each video becomes one **record**: id, title, channel, description, publish time, duration, when Rudder first saw it, and its thumbnail. Fields YouTube didn't send stay empty; Rudder doesn't go and fetch them.

### 2. Deciding: the pipeline

Each video goes through a **pipeline** of stages, in order (`extension/pipeline.js`). Every stage says **hide**, **show** or **pass** (no opinion). The first hide or show decides, and later stages don't run. A video that every stage passes is shown. A stage can also add notes to the record, such as the text it read on the thumbnail, for the stages after it.

The default pipeline:

| Stage | What it checks | Speed |
|---|---|---|
| **your-clicks** | You liked or disliked this exact video before | Instant |
| **keywords** | Your filters' words, and words related to them, in the title or channel name | Instant |
| **learned** | A small model of your own likes and dislikes, and channels you've disliked twice | A few ms |
| **thumbnail-text** | Your filters' words in the text written on the thumbnail | ~60–300 ms |

**Filters** are plain phrases like "video games" or "news, war, death". Each one expands into a list of words and related words: "news" also catches news channel names, "video games" catches game titles (`extension/youtube/keywords.js`). Rudder ships with 31 filters, and you can add or remove any of them in the popup.

The **thumbnail-text** stage reads the text on thumbnails with Tesseract OCR (`extension/ocr.js`). OCR often turns noise into short words, so only matches of 4+ letters count.

Slow stages run in batches, nearest the screen first, and only for videos no earlier stage has decided. What they learn about a video (its thumbnail text, its fingerprint, apps' answers) is remembered, so a video seen before is decided at once.

Other programs on your computer can change this pipeline or replace it completely; see [The API](#the-api) below.

### 3. Showing

- **Hidden until decided.** Every tile starts invisible but keeps its size, so the layout and YouTube's lazy loading work as normal (`extension/youtube/hide.css`). A rejected tile is taken out of the grid.
- **In order, no holes.** A tile appears only once every tile before it is decided, so the grid fills from the top and nothing on screen ever moves.
- **Topped up.** When Rudder removes videos, the home feed and sidebar would run short. Rudder briefly places YouTube's own "load more" spot on screen, invisibly, so YouTube fetches its next page the same way a scroll would. This is one of two places Rudder causes a request, both YouTube's own (the other is captions, below). Shorts rows are refilled from shorts the page already has.
- **The Shorts viewer.** Each short stays hidden and paused until it's checked. A rejected short is jumped over instantly, so it never slides past on screen.
- **Autoplay and end screens.** The next video only autoplays if it has passed. The player's own end-screen recommendations are always hidden.
- **Never filtered:** the video you're watching, the short you opened, and your playlists and history.
- **Captions.** On every video you watch, Rudder asks YouTube's player for English captions (a person's if there are any, else automatic ones, else another language translated to English), and the player downloads them. Rudder reads that download and sends apps each line as you watch it; lines you skip past aren't sent (`extension/youtube/captions.js`). They're drawn on the video only if you choose: the CC button and the C key show or hide them, and Rudder remembers your choice. Rudder keeps reading them either way.
- **Switches don't jump.** Turning Rudder off or on, or changing the pipeline (an app joining or leaving), never touches what's already shown: the change applies to the rest of the page. Turned off, the videos Rudder had hidden fill in below what you're reading, never above it. Editing the filters is different: every tile is decided again.

All of this is in `extension/youtube/feed.js`.

### 4. Learning from you

You can tell Rudder what you like in two places:

- **"Rudder: more like this" / "less like this"** in every video's ⋮ menu.
- **YouTube's own like and dislike buttons** on the video or short you're watching. They show Rudder's blue and red rudders, and one click tells both YouTube and Rudder.

Rudder turns each title and channel into a fingerprint with a small text model (MiniLM, `extension/text.js`) and trains a tiny classifier on your clicks (`extension/youtube/personal.js`). It starts after 3 dislikes and hides a video only when it's more than 75% sure you'd dislike it. A channel you've disliked twice, and never liked, is hidden.

### 5. The popup

The popup has one switch, filtering on or off, and otherwise shows statistics: how many videos were checked and hidden, your likes and dislikes, whether the learned model is on, the pipeline with how many videos each stage hid, your filters (add and remove), hidden channels, and recently hidden videos with the reason. Apps can add their own panels to it. A stage whose app isn't running is marked in the pipeline (striped when it's hiding what it would check).

## The API

Rudder can be controlled by other programs on your computer through a local gRPC API on port **7833**. A small bridge (`bridge/bridge.py`) serves it, since Firefox extensions can't serve gRPC themselves. Through it, a program can:

- read and replace the pipeline, or run its own stages (a local LLM, anything);
- receive every video's record and what happened to it;
- test videos against the pipeline, and time every stage;
- show its own panels in the popup.

The full reference is [API.md](../API.md), and [postman.md](postman.md) shows how to try every call by hand.

## Why it's built this way

- **No language model.** Rudder first used Gemma, a language model, on the GPU. It took ~45 seconds to load and 2.8 GB of graphics memory, and keywords were doing ~90% of the hiding anyway. Keywords, OCR and a tiny learned model on the processor show the first video in ~2.5 seconds. [history.md](history.md) tells the whole story.
- **Manifest V2.** It's the only way in Firefox to read responses as they arrive (`webRequest.filterResponseData`) and keep a background page alive.
- **Strict over convenient.** For someone avoiding a topic that upsets them, one video slipping through is worse than ten harmless ones hidden.

## Where things are

| Path | What |
|---|---|
| `extension/manifest.json` | The extension's definition |
| `extension/background.js` | Wires everything together: the built-in stages, the default pipeline, settings, the API link |
| `extension/pipeline.js` | The pipeline engine |
| `extension/youtube/intercept.js` | Reads YouTube's data and thumbnails into video records; answers the page's "may I show this?" |
| `extension/youtube/feed.js`, `hide.css`, `page.js` | The page side: hiding, revealing, filling, the Shorts viewer, menus, like buttons |
| `extension/youtube/keywords.js` | Filter phrases → words and related words |
| `extension/youtube/personal.js` | The like/dislike learner |
| `extension/ocr.js`, `text.js` | Tesseract OCR, MiniLM fingerprints |
| `extension/api.js`, `panel.js`, `timing.js` | The link to the bridge, apps' popup panels, stage timings |
| `extension/popup.html`, `popup.js` | The popup |
| `bridge/` | The local gRPC server and its contract (`rudder.proto`) |
| `tests/` | Checks that run without a browser (`npm test`, `npm run test:bridge`) |
| `research/testset/` | The labelled video set used to choose OCR and thresholds |
| `docs/` | This guide, the API in Postman, the development log, README images |

## Limits

- **Keywords only know words.** A gaming video whose title never names a game can pass; that's what your dislikes are for.
- **Thumbnails from the browser's cache can't be read**, because Rudder only sees images as they're downloaded. Those videos are judged on their title.
- **Descriptions are often empty.** The home page doesn't include them, and Rudder doesn't fetch them.
- **Firefox only, on desktop YouTube.**
