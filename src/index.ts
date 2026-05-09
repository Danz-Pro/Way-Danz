/*
Way-Danz
Optimized Wayground Cheat Engine
Based on quizizz-cheat by gbaranski, updated & enhanced for wayground.com

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with this
program. If not, see <https://www.gnu.org/licenses/>.

Original: https://github.com/gbaranski/quizizz-cheat
Enhanced: https://github.com/Danz-Pro/Way-Danz
*/

import { QuizQuestion, QuizInfo, CheatConfig } from "./types";

// ═══════════════════════════════════════════════════════
//  CONFIGURATION
// ═══════════════════════════════════════════════════════

const CONFIG: CheatConfig = {
  pollInterval: 400,           // Faster polling for smoother experience
  highlightColor: "#00E676",   // Bright green for correct answers
  dimOpacity: "15%",           // Dim wrong answers more aggressively
  autoAnswer: false,           // Auto-click correct answer (toggle via panel)
  showPanel: true,             // Show floating control panel
  debugMode: false,            // Verbose console logging
  retryAttempts: 3,            // Retry API fetch on failure
  retryDelay: 1500,            // Delay between retries (ms)
  mutationDebounce: 200,       // MutationObserver debounce time (ms)
};

// ═══════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════

let cachedQuiz: QuizInfo | null = null;
let lastQuestionID: string | undefined = undefined;
let isRunning = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let observer: MutationObserver | null = null;
let panelElement: HTMLElement | null = null;

// ═══════════════════════════════════════════════════════
//  PINIA STORE ACCESS (Vue 3)
// ═══════════════════════════════════════════════════════

const getPiniaInstance = () => {
  const root = document.querySelector("#root");
  if (!root) throw new Error("Could not find #root element");
  const vueApp = (root as any).__vue_app__;
  if (!vueApp) throw new Error("Could not find Vue app instance");
  const pinia = vueApp.config.globalProperties.$pinia;
  if (!pinia) throw new Error("Could not find Pinia store");
  return pinia;
};

const getStoreState = (storeName: string) => {
  const pinia = getPiniaInstance();
  const store = pinia._s.get(storeName);
  if (!store) throw new Error(`Could not find ${storeName} store`);
  return store.$state;
};

const getRoomHash = (): string => {
  const state = getStoreState("gameData");
  const roomHash = state.roomHash;
  if (!roomHash) throw new Error("Could not retrieve roomHash from gameData store");
  return roomHash;
};

const getCurrentQuestionId = (): string | null => {
  try {
    const state = getStoreState("gameQuestions");
    // Check all possible ID fields (handles different game modes)
    const currentId =
      state.currentId ||
      state.currentQuestionId ||
      state.cachedCurrentQuestionId;
    return currentId || null;
  } catch {
    return null;
  }
};

const getQuestionList = () => {
  try {
    const state = getStoreState("gameQuestions");
    return state.list || [];
  } catch {
    return [];
  }
};

const isInGame = (): boolean => {
  try {
    const state = getStoreState("gameData");
    return !!(state.roomHash && state.gameState);
  } catch {
    return false;
  }
};

// ═══════════════════════════════════════════════════════
//  API FETCH WITH RETRY
// ═══════════════════════════════════════════════════════

const fetchWithRetry = async (url: string, retries: number = CONFIG.retryAttempts): Promise<Response> => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    } catch (err: any) {
      log(`Fetch attempt ${attempt}/${retries} failed: ${err.message}`, "warn");
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, CONFIG.retryDelay * attempt));
      } else {
        throw err;
      }
    }
  }
  throw new Error("All retry attempts exhausted");
};

const fetchQuizData = async (): Promise<QuizInfo> => {
  const roomHash = getRoomHash();
  log(`Room hash: ${roomHash}`);

  const response = await fetchWithRetry(`https://wayground.com/_api/main/game/${roomHash}`);
  const quiz: QuizInfo = await response.json();
  log(`Loaded ${quiz.data.questions.length} questions`);
  return quiz;
};

// ═══════════════════════════════════════════════════════
//  OPTION DOM SELECTION (Enhanced)
// ═══════════════════════════════════════════════════════

const getOptionElements = (): HTMLElement[] => {
  // Strategy 1 (Best): [role="option"] elements
  const roleOptions = Array.from(document.querySelectorAll<HTMLElement>("[role='option']"));
  if (roleOptions.length >= 2) {
    // Filter for question-specific options with known CSS indicators
    const filtered = roleOptions.filter((el) => {
      const cl = el.className || "";
      const clStr = typeof cl === "object" ? Array.prototype.join.call(cl, " ") : cl;
      return (
        clStr.indexOf("is-selectable") !== -1 ||
        clStr.indexOf("is-mcq") !== -1 ||
        clStr.indexOf("is-msq") !== -1 ||
        clStr.indexOf("option-item") !== -1 ||
        clStr.indexOf("question-option") !== -1
      );
    });
    if (filtered.length >= 2) return filtered;
    return roleOptions;
  }

  // Strategy 2: Known container selectors
  const selectors = [
    "[data-testid='options-grid'] > *",
    "[data-testid='option-container'] > *",
    ".options-container > div",
    ".options-grid > div",
    ".question-options > div",
    ".option-button",
    "[class*='option-'][class*='index']",
    "button[class*='option']",
  ];

  for (const selector of selectors) {
    const elements = Array.from(document.querySelectorAll<HTMLElement>(selector));
    if (elements.length >= 2) {
      const options = elements.filter((el) => {
        const text = el.textContent || "";
        return text.trim().length > 0 && text.trim().length < 500;
      });
      if (options.length >= 2) return options;
    }
  }

  // Strategy 3: Heuristic - find buttons/clickable elements in the main game area
  const gameArea = document.querySelector("[data-testid='game-question'], .game-question, main");
  if (gameArea) {
    const buttons = Array.from(gameArea.querySelectorAll<HTMLElement>("button, [role='button'], [tabindex='0']"));
    const options = buttons.filter((el) => {
      const text = el.textContent || "";
      const rect = el.getBoundingClientRect();
      // Must have text content and be reasonably sized (not header/icon buttons)
      return text.trim().length > 1 && text.trim().length < 500 && rect.width > 50 && rect.height > 20;
    });
    if (options.length >= 2) return options;
  }

  throw new Error("Unable to find question option elements");
};

// ═══════════════════════════════════════════════════════
//  TEXT UTILITIES
// ═══════════════════════════════════════════════════════

const stripHtml = (html: string): string => {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return (tmp.textContent || tmp.innerText || "").trim();
};

const normalizeText = (text: string): string => {
  return text
    .toLowerCase()
    .replace(/[\s\u00A0]+/g, " ")
    .replace(/[^\w\s\u4e00-\u9fff]/g, "")
    .trim();
};

// ═══════════════════════════════════════════════════════
//  ANSWER HIGHLIGHTING (Enhanced)
// ═══════════════════════════════════════════════════════

const clearPreviousHighlights = () => {
  // Remove any previous highlights from all option elements
  document.querySelectorAll<HTMLElement>(
    "[role='option'], [data-testid='options-grid'] > *, .option-button, button[class*='option']"
  ).forEach((el) => {
    el.style.outline = "";
    el.style.outlineOffset = "";
    el.style.opacity = "";
    el.style.transition = "";
    el.style.boxShadow = "";
    el.style.transform = "";
    el.removeAttribute("data-way-danz-correct");
    el.removeAttribute("data-way-danz-wrong");
  });
};

const changeElementOpacity = (elem: HTMLElement) => {
  elem.style.opacity = CONFIG.dimOpacity;
  elem.style.transition = "opacity 0.4s ease";
  elem.setAttribute("data-way-danz-wrong", "true");
};

const highlightCorrectElement = (elem: HTMLElement) => {
  elem.style.outline = `3px solid ${CONFIG.highlightColor}`;
  elem.style.outlineOffset = "2px";
  elem.style.boxShadow = `0 0 12px ${CONFIG.highlightColor}40`;
  elem.style.transition = "outline 0.3s ease, box-shadow 0.3s ease, transform 0.2s ease";
  elem.style.transform = "scale(1.02)";
  elem.setAttribute("data-way-danz-correct", "true");
};

const autoClickAnswer = (elem: HTMLElement) => {
  if (!CONFIG.autoAnswer) return;
  // Small delay to make it look natural
  setTimeout(() => {
    elem.click();
    log("Auto-clicked correct answer");
  }, 300 + Math.random() * 700);
};

const highlightAnswers = (question: QuizQuestion) => {
  clearPreviousHighlights();

  // Handle supported question types
  const supportedTypes = ["MCQ", "MSQ", "BLANK", "MATCH", "REORDER", "GRAPH"];
  if (!supportedTypes.includes(question.type) && question.type !== "MCQ" && question.type !== "MSQ") {
    log(`Question type "${question.type}" is not supported for highlighting. Showing answer in panel.`, "info");
    showAnswerInPanel(question);
    return;
  }

  let optionElements: HTMLElement[];
  try {
    optionElements = getOptionElements();
  } catch (e: any) {
    log(`Could not find options: ${e.message}. Showing answer in panel.`, "warn");
    showAnswerInPanel(question);
    return;
  }

  const answer = question.structure.answer;

  // Handle empty options (show answer as text)
  if (!question.structure.options || question.structure.options.length < 1) {
    if (question.structure.query) {
      showAnswerInPanel(question);
    }
    return;
  }

  const correctAnswerIndices: number[] = [];

  if (Array.isArray(answer) && answer.length > 0) {
    // MSQ: multiple answers
    answer.forEach((idx) => {
      if (typeof idx === "number" && idx >= 0) correctAnswerIndices.push(idx);
    });
  } else if (typeof answer === "number" && answer >= 0) {
    // MCQ: single answer
    correctAnswerIndices.push(answer);
  }

  // Build correct answer text set for text-based fallback matching
  const correctAnswerTexts: Record<string, boolean> = {};
  correctAnswerIndices.forEach((idx) => {
    const opt = question.structure.options![idx];
    if (opt) {
      const txt = normalizeText(stripHtml(opt.text));
      if (txt.length > 0) {
        correctAnswerTexts[txt] = true;
      }
    }
  });

  let correctCount = 0;
  let firstCorrectElement: HTMLElement | null = null;

  optionElements.forEach((elem, domIndex) => {
    let isCorrect = false;

    // Strategy 1: Index-based matching (primary, most reliable)
    if (correctAnswerIndices.indexOf(domIndex) !== -1) {
      isCorrect = true;
    }

    // Strategy 2: Normalized text-based matching (fallback for shuffled/dynamic options)
    if (!isCorrect && Object.keys(correctAnswerTexts).length > 0) {
      const elemText = normalizeText(stripHtml(elem.textContent || ""));
      for (const correctText in correctAnswerTexts) {
        if (
          elemText.length > 0 &&
          correctText.length > 0 &&
          (elemText === correctText ||
            elemText.indexOf(correctText) !== -1 ||
            correctText.indexOf(elemText) !== -1)
        ) {
          isCorrect = true;
          break;
        }
      }
    }

    // Strategy 3: Check data attributes for option index
    if (!isCorrect) {
      const dataIdx = elem.getAttribute("data-index") || elem.getAttribute("data-option-index");
      if (dataIdx) {
        const attrIndex = parseInt(dataIdx, 10);
        if (!isNaN(attrIndex) && correctAnswerIndices.indexOf(attrIndex) !== -1) {
          isCorrect = true;
        }
      }
    }

    // Strategy 4: Check class name for option index (e.g., "option-3" means index 2)
    if (!isCorrect) {
      const cl = elem.className || "";
      const clStr = typeof cl === "object" ? Array.prototype.join.call(cl, " ") : cl;
      const match = clStr.match(/\boption-(\d+)\b/);
      if (match) {
        const classIndex = parseInt(match[1], 10) - 1;
        if (correctAnswerIndices.indexOf(classIndex) !== -1) {
          isCorrect = true;
        }
      }
    }

    if (isCorrect) {
      highlightCorrectElement(elem);
      correctCount++;
      if (!firstCorrectElement) firstCorrectElement = elem;
    } else {
      changeElementOpacity(elem);
    }
  });

  // Auto-click the first correct answer for MCQ
  if (firstCorrectElement && correctAnswerIndices.length === 1) {
    autoClickAnswer(firstCorrectElement);
  }

  log(`Highlighted ${correctCount} correct answer(s) out of ${optionElements.length} options`);

  // Update panel with current question info
  updatePanelQuestion(question, correctCount);
};

// ═══════════════════════════════════════════════════════
//  FLOATING CONTROL PANEL
// ═══════════════════════════════════════════════════════

const createPanel = () => {
  if (panelElement || !CONFIG.showPanel) return;

  const panel = document.createElement("div");
  panel.id = "way-danz-panel";
  panel.innerHTML = `
    <div id="way-danz-header">
      <span id="way-danz-title">Way-Danz</span>
      <button id="way-danz-minimize" title="Minimize">_</button>
    </div>
    <div id="way-danz-body">
      <div id="way-danz-status">Initializing...</div>
      <div id="way-danz-question-info"></div>
      <div id="way-danz-answer-display"></div>
      <div id="way-danz-controls">
        <label>
          <input type="checkbox" id="way-danz-auto-answer" ${CONFIG.autoAnswer ? "checked" : ""} />
          Auto-Answer
        </label>
        <label>
          <input type="checkbox" id="way-danz-debug" ${CONFIG.debugMode ? "checked" : ""} />
          Debug Mode
        </label>
      </div>
      <div id="way-danz-stats"></div>
    </div>
  `;

  const style = document.createElement("style");
  style.textContent = `
    #way-danz-panel {
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 99999;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      font-size: 13px;
      color: #e0e0e0;
      background: rgba(18, 18, 24, 0.95);
      border: 1px solid rgba(0, 230, 118, 0.3);
      border-radius: 10px;
      width: 260px;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5), 0 0 16px rgba(0, 230, 118, 0.1);
      backdrop-filter: blur(12px);
      user-select: none;
      transition: all 0.3s ease;
    }
    #way-danz-panel.minimized #way-danz-body { display: none; }
    #way-danz-panel.minimized { width: auto; border-radius: 8px; }
    #way-danz-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      cursor: move;
      background: linear-gradient(135deg, rgba(0, 230, 118, 0.15), rgba(0, 150, 80, 0.1));
      border-radius: 10px 10px 0 0;
      border-bottom: 1px solid rgba(0, 230, 118, 0.2);
    }
    #way-danz-panel.minimized #way-danz-header { border-radius: 8px; border-bottom: none; }
    #way-danz-title {
      font-weight: 700;
      font-size: 14px;
      letter-spacing: 0.5px;
      color: #00E676;
    }
    #way-danz-minimize {
      background: none;
      border: none;
      color: #888;
      cursor: pointer;
      font-size: 16px;
      padding: 0 4px;
      line-height: 1;
      transition: color 0.2s;
    }
    #way-danz-minimize:hover { color: #00E676; }
    #way-danz-body { padding: 10px 12px; }
    #way-danz-status {
      font-size: 12px;
      color: #aaa;
      margin-bottom: 6px;
    }
    #way-danz-status.active { color: #00E676; }
    #way-danz-question-info {
      font-size: 11px;
      color: #ccc;
      margin-bottom: 4px;
      max-height: 48px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #way-danz-answer-display {
      font-size: 12px;
      color: #00E676;
      margin: 6px 0;
      padding: 6px 8px;
      background: rgba(0, 230, 118, 0.08);
      border-radius: 6px;
      border-left: 3px solid #00E676;
      max-height: 80px;
      overflow-y: auto;
      word-break: break-word;
    }
    #way-danz-controls {
      margin: 8px 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    #way-danz-controls label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: #bbb;
      cursor: pointer;
    }
    #way-danz-controls input[type="checkbox"] {
      accent-color: #00E676;
    }
    #way-danz-stats {
      font-size: 11px;
      color: #666;
      margin-top: 6px;
    }
  `;

  document.head.appendChild(style);
  document.body.appendChild(panel);
  panelElement = panel;

  // Make panel draggable
  makeDraggable(panel, panel.querySelector("#way-danz-header")! as HTMLElement);

  // Minimize button
  panel.querySelector("#way-danz-minimize")!.addEventListener("click", () => {
    panel.classList.toggle("minimized");
  });

  // Auto-answer toggle
  panel.querySelector("#way-danz-auto-answer")!.addEventListener("change", (e: Event) => {
    CONFIG.autoAnswer = (e.target as HTMLInputElement).checked;
    log(`Auto-answer: ${CONFIG.autoAnswer ? "ON" : "OFF"}`);
  });

  // Debug toggle
  panel.querySelector("#way-danz-debug")!.addEventListener("change", (e: Event) => {
    CONFIG.debugMode = (e.target as HTMLInputElement).checked;
    log(`Debug mode: ${CONFIG.debugMode ? "ON" : "OFF"}`);
  });
};

const makeDraggable = (element: HTMLElement, handle: HTMLElement) => {
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let initialLeft = 0;
  let initialTop = 0;

  handle.addEventListener("mousedown", (e) => {
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = element.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    element.style.left = `${initialLeft + dx}px`;
    element.style.top = `${initialTop + dy}px`;
    element.style.right = "auto";
  });

  document.addEventListener("mouseup", () => {
    isDragging = false;
  });
};

const updatePanelStatus = (status: string, active: boolean = false) => {
  if (!panelElement) return;
  const el = panelElement.querySelector("#way-danz-status");
  if (el) {
    el.textContent = status;
    el.className = active ? "active" : "";
  }
};

const updatePanelQuestion = (question: QuizQuestion, correctCount: number) => {
  if (!panelElement) return;
  const infoEl = panelElement.querySelector("#way-danz-question-info");
  if (infoEl) {
    const queryText = question.structure.query ? stripHtml(question.structure.query.text || "") : "";
    infoEl.textContent = `Q: ${queryText.substring(0, 80)}${queryText.length > 80 ? "..." : ""} [${question.type}]`;
  }

  const answerEl = panelElement.querySelector("#way-danz-answer-display");
  if (answerEl && question.structure.options) {
    const answer = question.structure.answer;
    const indices: number[] = Array.isArray(answer) ? answer : [answer as number];
    const answerTexts = indices
      .filter((i) => question.structure.options![i])
      .map((i) => stripHtml(question.structure.options![i].text));
    answerEl.textContent = answerTexts.join(" | ");
  }
};

const showAnswerInPanel = (question: QuizQuestion) => {
  if (!panelElement) return;
  const answerEl = panelElement.querySelector("#way-danz-answer-display");
  if (answerEl) {
    const answer = question.structure.answer;
    if (question.structure.options && question.structure.options.length > 0) {
      const indices: number[] = Array.isArray(answer) ? answer : [answer as number];
      const answerTexts = indices
        .filter((i) => question.structure.options![i])
        .map((i) => stripHtml(question.structure.options![i].text));
      answerEl.textContent = `[${question.type}] ${answerTexts.join(" | ")}`;
    } else if (question.structure.query) {
      answerEl.textContent = `[${question.type}] See question for answer`;
    }
  }
};

// ═══════════════════════════════════════════════════════
//  MUTATION OBSERVER (Hybrid with Polling)
// ═══════════════════════════════════════════════════════

const setupMutationObserver = () => {
  if (observer) observer.disconnect();

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  observer = new MutationObserver(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      checkQuestionChange();
    }, CONFIG.mutationDebounce);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "data-testid", "role"],
  });
};

// ═══════════════════════════════════════════════════════
//  CORE LOGIC
// ═══════════════════════════════════════════════════════

const checkQuestionChange = () => {
  if (!cachedQuiz) return;

  try {
    const currentId = getCurrentQuestionId();
    if (!currentId || currentId === lastQuestionID) return;

    // Search in cached quiz data
    for (const q of cachedQuiz.data.questions) {
      if (currentId === q._id) {
        const queryText = q.structure.query ? stripHtml(q.structure.query.text || "") : "";
        log(`New question: "${queryText.substring(0, 60)}" [${q.type}]`);
        highlightAnswers(q);
        lastQuestionID = currentId;
        break;
      }
    }

    // Also check Pinia store question list (more up-to-date in some game modes)
    const storeQuestions = getQuestionList();
    if (storeQuestions.length > 0) {
      for (const q of storeQuestions) {
        if (currentId === q._id && currentId !== lastQuestionID) {
          const queryText = q.structure && q.structure.query ? stripHtml(q.structure.query.text || "") : "";
          log(`New question (from store): "${queryText.substring(0, 60)}" [${q.type}]`);
          highlightAnswers(q);
          lastQuestionID = currentId;
          break;
        }
      }
    }
  } catch (err: any) {
    if (err.message && !err.message.includes("Could not retrieve") && !err.message.includes("Could not find")) {
      log(`Error: ${err.message}`, "warn");
    }
  }
};

// ═══════════════════════════════════════════════════════
//  LOGGING
// ═══════════════════════════════════════════════════════

const log = (message: string, level: "info" | "warn" | "error" = "info") => {
  const prefix = "[Way-Danz]";
  if (level === "error") {
    console.error(`${prefix} ${message}`);
  } else if (level === "warn") {
    console.warn(`${prefix} ${message}`);
  } else if (CONFIG.debugMode || level === "info") {
    console.log(`${prefix} ${message}`);
  }
};

// ═══════════════════════════════════════════════════════
//  MAIN EXECUTION
// ═══════════════════════════════════════════════════════

const startCheat = async () => {
  if (isRunning) {
    log("Already running");
    return;
  }
  isRunning = true;

  const banner = `%c
  ╦ ╦╔═╗╔╗ ╔═╗╦ ╦╔═╗
  ║║║║╣ ╠╩╗╚═╗╠═╣║╣
  ╚╩╝╚═╝╚═╝╚═╝╩ ╩╚═╝
  Wayground Cheat Engine v3.0
  https://github.com/Danz-Pro/Way-Danz
  `;
  console.log(banner, "color: #00E676; font-weight: bold; font-size: 12px;");

  createPanel();
  updatePanelStatus("Connecting...", false);

  try {
    // Wait for game to be ready
    let attempts = 0;
    const maxWait = 30; // 30 seconds max wait

    while (!isInGame() && attempts < maxWait) {
      updatePanelStatus(`Waiting for game... (${attempts + 1}s)`);
      await new Promise((r) => setTimeout(r, 1000));
      attempts++;
    }

    if (!isInGame()) {
      updatePanelStatus("No active game found. Join a game first!", false);
      log("No active game found. Please join a game first.");
      isRunning = false;
      return;
    }

    // Fetch quiz data
    updatePanelStatus("Fetching quiz data...", false);
    cachedQuiz = await fetchQuizData();

    updatePanelStatus(`Active - ${cachedQuiz.data.questions.length} questions loaded`, true);
    log(`Script loaded! ${cachedQuiz.data.questions.length} questions ready.`);

    // Setup hybrid detection: MutationObserver + interval polling
    setupMutationObserver();

    pollTimer = setInterval(() => {
      checkQuestionChange();
    }, CONFIG.pollInterval);

    // Initial check
    checkQuestionChange();

  } catch (err: any) {
    updatePanelStatus(`Error: ${err.message}`, false);
    log(`Fatal error: ${err.message}`, "error");
    isRunning = false;
  }
};

const stopCheat = () => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  clearPreviousHighlights();
  if (panelElement) {
    panelElement.remove();
    panelElement = null;
  }
  isRunning = false;
  cachedQuiz = null;
  lastQuestionID = undefined;
  log("Stopped");
};

// ═══════════════════════════════════════════════════════
//  GLOBAL API (for console access)
// ═══════════════════════════════════════════════════════

(window as any).WayDanz = {
  start: startCheat,
  stop: stopCheat,
  config: CONFIG,
  setAutoAnswer: (val: boolean) => {
    CONFIG.autoAnswer = val;
    log(`Auto-answer: ${val ? "ON" : "OFF"}`);
  },
  setHighlightColor: (color: string) => {
    CONFIG.highlightColor = color;
    log(`Highlight color: ${color}`);
  },
};

// Auto-start
startCheat();
