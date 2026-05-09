# Way-Danz ⚡

**Optimized Wayground Cheat Engine** — Automatically highlights correct answers on [wayground.com](https://wayground.com/join/dashboard).

Based on [quizizz-cheat](https://github.com/gbaranski/quizizz-cheat) by gbaranski, heavily optimized and enhanced.

---

## ✨ Features

- **Auto-Highlight** — Correct answers get a green border + glow, wrong answers are dimmed
- **Auto-Answer** — Optional auto-click on the correct answer (toggle via panel)
- **Floating Control Panel** — Draggable, minimizable panel with real-time status
- **Hybrid Detection** — MutationObserver + interval polling for instant question changes
- **Retry Logic** — Automatic API retry with exponential backoff
- **Multiple Question Types** — Supports MCQ, MSQ, and shows answers for other types in-panel
- **4-Way Answer Matching** — Index-based, text-based, data-attribute, and CSS class strategies
- **Global Console API** — Control the cheat via `WayDanz.start()`, `WayDanz.stop()`, etc.

## 🚀 How to Use

### Method 1: Console Injection (Quick)

1. Join a quiz/game on [wayground.com](https://wayground.com/join/dashboard)
2. Open browser console (`F12` → Console)
3. Paste this code:

```js
fetch("https://raw.githubusercontent.com/Danz-Pro/Way-Danz/main/dist/bundle.js")
  .then((res) => res.text())
  .then((t) => eval(t))
```

4. The floating **Way-Danz** panel will appear in the top-right corner
5. Correct answers are automatically highlighted with a green border + glow

### Method 2: Tampermonkey (Auto-Load)

1. Install [Tampermonkey](https://www.tampermonkey.net/) browser extension
2. Create a new user script
3. Paste the contents of [`scripts/tampermonkey-alternative-method.js`](scripts/tampermonkey-alternative-method.js)
4. The script will automatically load every time you visit wayground.com

### Method 3: Console API

Once loaded, you can control the cheat via the browser console:

```js
WayDanz.start()                    // Start the cheat engine
WayDanz.stop()                     // Stop the cheat engine
WayDanz.setAutoAnswer(true)        // Enable auto-answer
WayDanz.setAutoAnswer(false)       // Disable auto-answer
WayDanz.setHighlightColor("#FF5722") // Change highlight color
WayDanz.config                     // View current config
```

## 🎮 Control Panel

The floating panel provides:

| Feature | Description |
|---------|-------------|
| **Status** | Shows current connection state and question count |
| **Question Info** | Current question text and type |
| **Answer Display** | Correct answer text shown in green box |
| **Auto-Answer Toggle** | Click to enable/disable automatic answer clicking |
| **Debug Mode** | Enable verbose console logging |
| **Minimize** | Collapse the panel to just the header |
| **Drag** | Drag the header to reposition the panel |

## 🔧 Building

```bash
npm install
npm run build
```

Output: `dist/bundle.js`

For development (unminified):
```bash
npm run build:dev
```

## 🛠 Technical Details

| Component | Details |
|-----------|---------|
| **Framework** | Vue 3 + Pinia (accessed via `#root.__vue_app__`) |
| **Pinia Stores** | `gameData` → `roomHash`, `gameQuestions` → `currentId` / `cachedCurrentQuestionId` |
| **API** | `GET https://wayground.com/_api/main/game/{roomHash}` — returns full quiz with correct answers |
| **Detection** | MutationObserver (DOM changes) + 400ms interval polling (Pinia state) |
| **Answer Matching** | 4 strategies: index-based → normalized text → data-attributes → CSS class parsing |

## 🔄 Changes from Original wayground-cheat

- **v3.0** — Complete rewrite with floating control panel, auto-answer, MutationObserver, retry logic, and more
- **v2.0** — Updated for wayground.com (Vue 3 + Pinia)
- **v1.0** — Original quizizz-cheat by gbaranski

## ⚖️ License

AGPL-3.0 (Original quizizz-cheat license)
