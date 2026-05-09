/*
Way-Danz v4.0
Optimized Wayground Cheat Engine
Based on quizizz-cheat by gbaranski, updated & enhanced for wayground.com

KEY FIXES in v4.0:
  - Use /api/main/quiz/{quizId} API (returns correct answers reliably)
  - Fallback to /api/main/game/{roomHash} API
  - Fallback to Pinia store extraction
  - Fix BLANK question answer parsing (optionId→options[].id mapping)
  - Fix normalizeText (don't strip meaningful trailing numbers)
  - Better question detection via gameQuestions.list + currentId
  - Improved text matching (fuzzy, number-aware, HTML-entity aware)
  - Anti-race: processing lock with timeout

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

import { QuizQuestion, QuizInfo, QuizApiResponse, BlankAnswerItem, CheatConfig } from "./types";

// ═══════════════════════════════════════════════════════
//  CONFIGURATION
// ═══════════════════════════════════════════════════════

const CONFIG: CheatConfig = {
  pollInterval: 400,
  highlightColor: "#00E676",
  dimOpacity: "15%",
  autoAnswer: false,
  showPanel: true,
  debugMode: false,
  retryAttempts: 3,
  retryDelay: 1500,
  mutationDebounce: 250,
  firstQuestionRetryDelay: 500,
  firstQuestionMaxRetries: 12,
};

// ═══════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════

let cachedQuestions: Map<string, QuizQuestion> = new Map();
let lastQuestionID: string | undefined = undefined;
let isRunning = false;
let isProcessing = false;
let processingTimeout: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let observer: MutationObserver | null = null;
let panelElement: HTMLElement | null = null;
let lastHighlightedElements: HTMLElement[] = [];
let observerIsPaused = false;
let questionsLoaded = false;
let statsCorrect = 0;
let statsTotal = 0;

// ═══════════════════════════════════════════════════════
//  PINIA STORE ACCESS (Vue 3)
// ═══════════════════════════════════════════════════════

const getPiniaInstance = (): any => {
  const root = document.querySelector("#root") || document.querySelector("#app");
  if (!root) return null;
  const vueApp = (root as any).__vue_app__;
  if (!vueApp) return null;
  const pinia = vueApp.config.globalProperties.$pinia;
  if (!pinia) return null;
  return pinia;
};

const getStoreState = (storeName: string): any => {
  const pinia = getPiniaInstance();
  if (!pinia) return null;
  const store = pinia._s.get(storeName);
  if (!store) return null;
  return store.$state;
};

const getStoreValue = (storeName: string, key: string): any => {
  const state = getStoreState(storeName);
  if (!state) return null;
  return state[key] || null;
};

const getRoomHash = (): string | null => {
  return getStoreValue("gameData", "roomHash");
};

const getQuizId = (): string | null => {
  return getStoreValue("gameData", "quizId");
};

const getCurrentQuestionId = (): string | null => {
  const state = getStoreState("gameQuestions");
  if (!state) return null;

  // Try multiple property names
  const directId = state.currentId || state.currentQuestionId || state.cachedCurrentQuestionId;
  if (directId) return directId;

  // Try to get from gameFlow or other stores
  const flowState = getStoreState("gameFlow");
  if (flowState) {
    const flowId = flowState.currentQuestionId || flowState.cachedCurrentQuestionId;
    if (flowId) return flowId;
  }

  return null;
};

const isInGame = (): boolean => {
  try {
    const state = getStoreState("gameData");
    return !!(state && state.roomHash && state.gameState);
  } catch {
    return false;
  }
};

/**
 * Extract questions directly from Pinia store as last resort.
 * The gameQuestions.list is an object keyed by question ID.
 * NOTE: Answer field may be -1 or [] before answering (anti-cheat),
 * but we try anyway as a fallback.
 */
const extractQuestionsFromStore = (): QuizQuestion[] => {
  const state = getStoreState("gameQuestions");
  if (!state || !state.list) return [];

  const questions: QuizQuestion[] = [];
  const list = state.list;

  if (typeof list === "object") {
    for (const id of Object.keys(list)) {
      const q = list[id];
      if (q && q.type && q.structure) {
        questions.push({
          _id: id,
          type: q.type,
          structure: {
            answer: q.structure.answer,
            options: q.structure.options || [],
            query: q.structure.query,
          },
        });
      }
    }
  }

  return questions;
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
      log(`Fetch attempt ${attempt}/${retries} failed for ${url}: ${err.message}`, "warn");
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, CONFIG.retryDelay * attempt));
      } else {
        throw err;
      }
    }
  }
  throw new Error("All retry attempts exhausted");
};

/**
 * PRIMARY: Fetch quiz data from /api/main/quiz/{quizId}
 * This endpoint reliably returns correct answers for ALL question types.
 */
const fetchQuizDataFromQuizAPI = async (quizId: string): Promise<QuizQuestion[]> => {
  log(`Fetching quiz data from quiz API: quizId=${quizId}`);

  const response = await fetchWithRetry(`https://wayground.com/_api/main/quiz/${quizId}`);
  const data: QuizApiResponse = await response.json();

  if (!data.success || !data.data?.quiz?.info?.questions) {
    throw new Error("Quiz API response missing question data");
  }

  const questions = data.data.quiz.info.questions;
  log(`Quiz API: Loaded ${questions.length} questions with answers`);

  // Debug: Log first question answer format
  if (questions.length > 0) {
    const q0 = questions[0];
    log(`First question: type=${q0.type}, answer=${JSON.stringify(q0.structure.answer)}, options=${q0.structure.options?.length || 0}`);
  }

  return questions;
};

/**
 * FALLBACK 1: Fetch quiz data from /api/main/game/{roomHash}
 * This may or may not include correct answers depending on game state.
 */
const fetchQuizDataFromGameAPI = async (roomHash: string): Promise<QuizQuestion[]> => {
  log(`Fetching quiz data from game API: roomHash=${roomHash}`);

  const response = await fetchWithRetry(`https://wayground.com/_api/main/game/${roomHash}`);
  const data: QuizInfo = await response.json();

  if (!data.data?.questions) {
    throw new Error("Game API response missing question data");
  }

  const questions = data.data.questions;
  log(`Game API: Loaded ${questions.length} questions`);

  return questions;
};

/**
 * Main quiz data fetcher - tries multiple sources in priority order.
 * Returns true if questions were successfully loaded.
 */
const fetchQuizData = async (): Promise<boolean> => {
  const quizId = getQuizId();
  const roomHash = getRoomHash();

  let questions: QuizQuestion[] = [];

  // Strategy 1: Quiz API (most reliable - always has correct answers)
  if (quizId) {
    try {
      questions = await fetchQuizDataFromQuizAPI(quizId);
      if (questions.length > 0) {
        log(`Loaded ${questions.length} questions from Quiz API (PRIMARY)`);
      }
    } catch (err: any) {
      log(`Quiz API failed: ${err.message}`, "warn");
    }
  } else {
    log("No quizId available, skipping Quiz API", "warn");
  }

  // Strategy 2: Game API (may have answers)
  if (questions.length === 0 && roomHash) {
    try {
      questions = await fetchQuizDataFromGameAPI(roomHash);
      if (questions.length > 0) {
        log(`Loaded ${questions.length} questions from Game API (FALLBACK 1)`);
      }
    } catch (err: any) {
      log(`Game API failed: ${err.message}`, "warn");
    }
  }

  // Strategy 3: Extract from Pinia store (last resort, may have answer=-1)
  if (questions.length === 0) {
    try {
      questions = extractQuestionsFromStore();
      if (questions.length > 0) {
        log(`Loaded ${questions.length} questions from Pinia store (FALLBACK 2 - answers may be hidden)`);
      }
    } catch (err: any) {
      log(`Pinia extraction failed: ${err.message}`, "warn");
    }
  }

  if (questions.length === 0) {
    log("All data sources failed!", "error");
    return false;
  }

  // Store questions in map for fast lookup by ID
  cachedQuestions.clear();
  questions.forEach((q) => {
    cachedQuestions.set(q._id, q);
  });

  // Verify that we have actual answer data (not -1 or empty)
  let validAnswers = 0;
  cachedQuestions.forEach((q) => {
    const answerData = buildAnswerData(q);
    if (answerData.texts.length > 0 || answerData.correctImageUrls.length > 0 || answerData.blankAnswerTexts.length > 0) {
      validAnswers++;
    }
  });

  log(`Answer data quality: ${validAnswers}/${questions.length} questions have extractable answers`);

  if (validAnswers === 0 && quizId) {
    // Answers all empty - try refetching quiz API once more with delay
    log("No valid answers found, retrying Quiz API in 2s...", "warn");
    await new Promise((r) => setTimeout(r, 2000));
    try {
      questions = await fetchQuizDataFromQuizAPI(quizId);
      cachedQuestions.clear();
      questions.forEach((q) => {
        cachedQuestions.set(q._id, q);
      });
      validAnswers = 0;
      cachedQuestions.forEach((q) => {
        const answerData = buildAnswerData(q);
        if (answerData.texts.length > 0 || answerData.correctImageUrls.length > 0 || answerData.blankAnswerTexts.length > 0) {
          validAnswers++;
        }
      });
      log(`Retry: ${validAnswers}/${questions.length} questions have answers`);
    } catch (err: any) {
      log(`Retry failed: ${err.message}`, "error");
    }
  }

  questionsLoaded = true;
  return true;
};

// ═══════════════════════════════════════════════════════
//  OPTION DOM SELECTION
// ═══════════════════════════════════════════════════════

const getOptionElements = (): HTMLElement[] => {
  // Strategy 1: [role="option"] elements (most reliable on wayground)
  const roleOptions = Array.from(document.querySelectorAll<HTMLElement>("[role='option']"));
  if (roleOptions.length >= 2) {
    // Filter to actual selectable options
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
    // If no filter match, use all role=option elements (they might all be valid)
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

  // Strategy 3: Heuristic - find clickable elements in game area
  const gameArea = document.querySelector("[data-testid='game-question'], .game-question, main");
  if (gameArea) {
    const buttons = Array.from(gameArea.querySelectorAll<HTMLElement>("button, [role='button'], [tabindex='0']"));
    const options = buttons.filter((el) => {
      const text = el.textContent || "";
      const rect = el.getBoundingClientRect();
      return text.trim().length > 1 && text.trim().length < 500 && rect.width > 50 && rect.height > 20;
    });
    if (options.length >= 2) return options;
  }

  throw new Error("Unable to find question option elements");
};

// ═══════════════════════════════════════════════════════
//  TEXT & IMAGE UTILITIES
// ═══════════════════════════════════════════════════════

const stripHtml = (html: string): string => {
  if (!html) return "";
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return (tmp.textContent || tmp.innerText || "").trim();
};

/**
 * Normalize text for comparison:
 * - lowercase
 * - collapse whitespace
 * - remove punctuation for matching
 * - trim
 *
 * NOTE: We do NOT strip trailing numbers anymore because they can be
 * part of the actual answer content (e.g., "3D", "World War 2", "H2O").
 * Wayground used to append option indices to text but that's handled
 * by the matching algorithm instead.
 */
const normalizeText = (text: string): string => {
  return text
    .toLowerCase()
    .replace(/[\s\u00A0]+/g, " ")
    .replace(/[^\w\s\u4e00-\u9fff]/g, "")
    .trim();
};

/**
 * More aggressive normalization that also strips trailing digits.
 * Used only as a fallback when exact normalized match fails.
 */
const normalizeTextAggressive = (text: string): string => {
  return text
    .toLowerCase()
    .replace(/[\s\u00A0]+/g, " ")
    .replace(/\s*\d+\s*$/, "")   // Remove trailing numbers like "1", "2", "3"
    .replace(/[^\w\s\u4e00-\u9fff]/g, "")
    .trim();
};

/**
 * Extract the background-image URL from a DOM element.
 * Wayground renders image options as CSS background-image on nested divs.
 * Returns the base URL (without query params) for matching.
 */
const extractImageUrl = (elem: HTMLElement): string | null => {
  // Check element itself and all descendant divs
  const elements = [elem, ...Array.from(elem.querySelectorAll<HTMLElement>("div"))];
  for (const el of elements) {
    const bg = el.style.backgroundImage || getComputedStyle(el).backgroundImage;
    if (bg && (bg.indexOf("quizizz") !== -1 || bg.indexOf("wayground") !== -1 || bg.indexOf("cloudinary") !== -1)) {
      const match = bg.match(/url\(["']?([^"')]+)["']?\)/);
      if (match) {
        return match[1].split("?")[0];
      }
    }
  }
  return null;
};

// ═══════════════════════════════════════════════════════
//  ANSWER DATA BUILDER (v4.0 — Full BLANK/MSQ/Image support)
// ═══════════════════════════════════════════════════════

interface AnswerData {
  /** Normalized text of correct answers (for text-based matching) */
  texts: string[];
  /** Raw (non-normalized) text of correct answers for display */
  rawTexts: string[];
  /** Whether any correct option is image-based (no text) */
  hasImageOptions: boolean;
  /** API indices of correct answers */
  correctIndices: number[];
  /** Image URLs of correct options (for image-based matching) */
  correctImageUrls: string[];
  /** For BLANK/OPEN: the answer text from options */
  blankAnswerTexts: string[];
}

/**
 * Build answer data from the API question structure.
 *
 * Handles all question types:
 *   MCQ: answer = number (0-based index into options)
 *   MSQ: answer = number[] (indices of correct options)
 *   BLANK: answer = [{targetId, optionId}] — map optionId to options[].id
 *   OPEN: answer = [] or [{targetId, optionId}]
 */
const buildAnswerData = (question: QuizQuestion): AnswerData => {
  const answer = question.structure.answer;
  const options = question.structure.options || [];
  const result: AnswerData = {
    texts: [],
    rawTexts: [],
    hasImageOptions: false,
    correctIndices: [],
    correctImageUrls: [],
    blankAnswerTexts: [],
  };

  if (!options || options.length === 0) {
    // BLANK questions may have empty options from game API
    // but quiz API should have them
    return result;
  }

  // ---- BLANK / OPEN questions ----
  if (question.type === "BLANK" || question.type === "OPEN") {
    // Quiz API format: answer = [{targetId: "...", optionId: ["..."]}]
    if (Array.isArray(answer) && answer.length > 0 && typeof answer[0] === "object" && answer[0] !== null) {
      // Build an option ID → text map
      const optionMap = new Map<string, string>();
      options.forEach((opt) => {
        if (opt.id) {
          optionMap.set(opt.id, stripHtml(opt.text));
        }
      });

      (answer as BlankAnswerItem[]).forEach((ansItem) => {
        if (ansItem.optionId && Array.isArray(ansItem.optionId)) {
          ansItem.optionId.forEach((optId) => {
            const text = optionMap.get(optId);
            if (text && text.length > 0) {
              result.blankAnswerTexts.push(text);
            }
          });
        }
      });
    } else {
      // Fallback: all options are answers for BLANK
      options.forEach((opt) => {
        const rawText = stripHtml(opt.text);
        if (rawText.length > 0) {
          result.blankAnswerTexts.push(rawText);
        }
      });
    }
    return result;
  }

  // ---- MCQ / MSQ questions ----
  // Collect indices of correct answers
  if (Array.isArray(answer)) {
    answer.forEach((idx) => {
      if (typeof idx === "number" && idx >= 0) {
        result.correctIndices.push(idx);
      }
    });
  } else if (typeof answer === "number" && answer >= 0) {
    result.correctIndices.push(answer);
  }
  // Handle answer = -1 (server hiding answer) - no indices available
  // Handle answer = [] (empty array for MSQ) - no indices available

  // Build correct answer texts and image URLs from indices
  result.correctIndices.forEach((idx) => {
    if (idx < options.length) {
      const opt = options[idx];
      const rawText = stripHtml(opt.text);
      const txt = normalizeText(rawText);

      if (txt.length > 0) {
        result.texts.push(txt);
        result.rawTexts.push(rawText);
      } else {
        // Empty text = image-based option
        result.hasImageOptions = true;
      }

      // Extract image URL for image-based matching
      if (opt.media && opt.media.length > 0 && opt.media[0].url) {
        const url = opt.media[0].url.split("?")[0];
        result.correctImageUrls.push(url);
      }
    }
  });

  // If ALL correct answers have empty text but we have indices, mark as image-based
  if (result.texts.length === 0 && result.correctIndices.length > 0) {
    result.hasImageOptions = true;
  }

  // Also check if ANY correct option is image-type
  if (!result.hasImageOptions && result.correctIndices.length > 0) {
    const hasAnyImageOption = result.correctIndices.some((idx) => {
      if (idx >= options.length) return false;
      const opt = options[idx];
      return opt.type === "image" || (opt.media && opt.media.length > 0 && stripHtml(opt.text).length === 0);
    });
    if (hasAnyImageOption) {
      result.hasImageOptions = true;
    }
  }

  return result;
};

// ═══════════════════════════════════════════════════════
//  ANSWER HIGHLIGHTING (v4.0 — Robust multi-strategy matching)
// ═══════════════════════════════════════════════════════

const clearPreviousHighlights = () => {
  lastHighlightedElements.forEach((el) => {
    if (el && el.parentNode) {
      el.style.outline = "";
      el.style.outlineOffset = "";
      el.style.opacity = "";
      el.style.transition = "";
      el.style.boxShadow = "";
      el.style.transform = "";
      el.removeAttribute("data-way-danz-correct");
      el.removeAttribute("data-way-danz-wrong");
    }
  });
  lastHighlightedElements = [];

  // Broad sweep for any leftover highlights
  document.querySelectorAll<HTMLElement>("[data-way-danz-correct], [data-way-danz-wrong]").forEach((el) => {
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
  setTimeout(() => {
    elem.click();
    log("Auto-clicked correct answer");
  }, 300 + Math.random() * 700);
};

/**
 * Check if a DOM element's text matches any correct answer text.
 * Multi-level matching strategy:
 *   1. Exact normalized match (after lowercase, whitespace collapse, punctuation strip)
 *   2. Aggressive normalized match (also strips trailing numbers - for wayground index suffixes)
 *   3. Substring containment (for cases where DOM has extra wrapper text)
 *   4. Numeric content match (for number-only answers like "3.21")
 */
const isElementCorrectByText = (elem: HTMLElement, correctTexts: string[]): boolean => {
  const elemRawText = stripHtml(elem.textContent || "");
  const elemText = normalizeText(elemRawText);
  if (elemText.length === 0) return false;

  for (const correctText of correctTexts) {
    if (correctText.length === 0) continue;

    // Level 1: Exact normalized match
    if (elemText === correctText) return true;
  }

  // Level 2: Aggressive normalization (strips trailing numbers)
  const elemTextAggressive = normalizeTextAggressive(elemRawText);
  for (const correctText of correctTexts) {
    const correctTextAggressive = normalizeTextAggressive(
      // Re-derive from original since correctText is already normalized
      correctTexts.length > 0 ? correctText : ""
    );
    if (correctTextAggressive.length >= 2 && elemTextAggressive === correctTextAggressive) return true;
  }

  // Level 3: Substring containment
  for (const correctText of correctTexts) {
    if (correctText.length >= 2 && elemText.length >= 2) {
      if (elemText.indexOf(correctText) !== -1 || correctText.indexOf(elemText) !== -1) {
        return true;
      }
    }
  }

  // Level 4: Numeric comparison (for math questions)
  const elemNum = parseFloat(elemRawText.replace(/[^\d.\-]/g, ""));
  for (const correctText of correctTexts) {
    const correctNum = parseFloat(correctText.replace(/[^\d.\-]/g, ""));
    if (!isNaN(elemNum) && !isNaN(correctNum) && Math.abs(elemNum - correctNum) < 0.001) {
      return true;
    }
  }

  return false;
};

/**
 * Check if a DOM element's background-image URL matches any correct answer image URL.
 */
const isElementCorrectByImage = (elem: HTMLElement, correctImageUrls: string[]): boolean => {
  const elemImageUrl = extractImageUrl(elem);
  if (!elemImageUrl) return false;

  for (const correctUrl of correctImageUrls) {
    if (correctUrl.length === 0) continue;
    if (elemImageUrl === correctUrl) return true;
    // Also check substring for URL format differences
    if (elemImageUrl.indexOf(correctUrl) !== -1 || correctUrl.indexOf(elemImageUrl) !== -1) return true;
  }

  return false;
};

/**
 * Core highlight function.
 *
 * Matching strategy (in priority order):
 *   1. TEXT-BASED matching — compare normalized text of DOM options with API answer texts
 *   2. IMAGE URL matching — compare background-image URLs with media[].url from API
 *   3. Never use index-based matching — Wayground SHUFFLES option order!
 */
const highlightAnswers = (question: QuizQuestion): boolean => {
  pauseObserver();
  try {
    clearPreviousHighlights();

    // Build answer data
    const answerData = buildAnswerData(question);

    // For BLANK/OPEN questions, just show answer in panel (no selectable DOM options)
    if (question.type === "BLANK" || question.type === "OPEN") {
      showAnswerInPanel(question);
      return true;
    }

    // Check if we have any answer data to highlight
    const hasAnswerData = answerData.texts.length > 0 || answerData.correctImageUrls.length > 0;
    if (!hasAnswerData) {
      log(`No answer data available for this question (answer may be hidden by server)`, "warn");
      showAnswerInPanel(question);
      return true;
    }

    // Try to find DOM option elements
    let optionElements: HTMLElement[];
    try {
      optionElements = getOptionElements();
    } catch {
      // Options not rendered yet — signal retry
      showAnswerInPanel(question);
      return false;
    }

    const correctTexts = answerData.texts;
    const isImageBased = answerData.hasImageOptions;
    const correctImageUrls = answerData.correctImageUrls;

    log(`Highlighting: ${correctTexts.length} text answers, ${correctImageUrls.length} image answers, ${isImageBased ? "image-based" : "text-based"}`);

    let correctCount = 0;
    let firstCorrectElement: HTMLElement | null = null;
    const styledElements: HTMLElement[] = [];

    optionElements.forEach((elem) => {
      let elemIsCorrect = false;

      // Strategy 1: Text-based matching
      if (!elemIsCorrect && correctTexts.length > 0) {
        elemIsCorrect = isElementCorrectByText(elem, correctTexts);
      }

      // Strategy 2: Image URL matching
      if (!elemIsCorrect && isImageBased && correctImageUrls.length > 0) {
        elemIsCorrect = isElementCorrectByImage(elem, correctImageUrls);
      }

      if (elemIsCorrect) {
        highlightCorrectElement(elem);
        correctCount++;
        if (!firstCorrectElement) firstCorrectElement = elem;
      } else {
        changeElementOpacity(elem);
      }
      styledElements.push(elem);
    });

    lastHighlightedElements = styledElements;

    // Auto-click for MCQ (single correct answer)
    if (firstCorrectElement && answerData.correctIndices.length === 1) {
      autoClickAnswer(firstCorrectElement);
    }

    statsTotal++;
    if (correctCount > 0) statsCorrect++;

    log(`Highlighted ${correctCount} correct answer(s) out of ${optionElements.length} options`);
    updatePanelQuestion(question, correctCount);
    updateStats();
    return true;
  } finally {
    resumeObserver();
  }
};

// ═══════════════════════════════════════════════════════
//  MUTATION OBSERVER
// ═══════════════════════════════════════════════════════

const pauseObserver = () => {
  if (observer && !observerIsPaused) {
    observer.disconnect();
    observerIsPaused = true;
  }
};

const resumeObserver = () => {
  if (observer && observerIsPaused) {
    observerIsPaused = false;
    setTimeout(() => {
      if (observer && !observerIsPaused) {
        setupMutationObserver();
      }
    }, 100);
  }
};

const setupMutationObserver = () => {
  if (observer) observer.disconnect();

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  observer = new MutationObserver((mutations) => {
    if (observerIsPaused) return;

    const relevantMutation = mutations.some((m) => {
      if (m.type === "attributes") {
        const target = m.target as HTMLElement;
        if (target.hasAttribute("data-way-danz-correct") || target.hasAttribute("data-way-danz-wrong")) {
          return false;
        }
        if (m.attributeName === "style") return false;
        return true;
      }
      return m.type === "childList";
    });

    if (!relevantMutation) return;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (!observerIsPaused) {
        checkQuestionChange();
      }
    }, CONFIG.mutationDebounce);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "data-testid", "role"],
  });

  observerIsPaused = false;
};

// ═══════════════════════════════════════════════════════
//  CORE LOGIC
// ═══════════════════════════════════════════════════════

/**
 * Check if a question type can have highlightable DOM options.
 */
const isOptionQuestionType = (type: string): boolean => {
  return ["MCQ", "MSQ"].includes(type);
};

const tryHighlightWithRetry = async (question: QuizQuestion, questionId: string) => {
  // If this question type doesn't have selectable options, just show answer
  if (!isOptionQuestionType(question.type)) {
    showAnswerInPanel(question);
    lastQuestionID = questionId;
    return;
  }

  // For MCQ/MSQ, retry until options appear in DOM
  let success = false;
  let attempts = 0;

  while (!success && attempts < CONFIG.firstQuestionMaxRetries) {
    success = highlightAnswers(question);
    if (success) break;

    attempts++;
    log(`Options not ready, retry ${attempts}/${CONFIG.firstQuestionMaxRetries} in ${CONFIG.firstQuestionRetryDelay}ms`, "warn");
    await new Promise((r) => setTimeout(r, CONFIG.firstQuestionRetryDelay));
  }

  if (!success) {
    log(`Failed to highlight after ${CONFIG.firstQuestionMaxRetries} retries. Answer shown in panel.`, "warn");
  }

  lastQuestionID = questionId;
};

const checkQuestionChange = () => {
  if (!questionsLoaded || isProcessing) return;

  try {
    const currentId = getCurrentQuestionId();
    if (!currentId || currentId === lastQuestionID) return;

    // Find the question in cached quiz data
    const foundQuestion = cachedQuestions.get(currentId);
    if (!foundQuestion) {
      log(`Question ID ${currentId} not found in cache (${cachedQuestions.size} questions cached)`, "warn");
      return;
    }

    isProcessing = true;

    // Safety timeout: auto-release processing lock after 10 seconds
    processingTimeout = setTimeout(() => {
      if (isProcessing) {
        log("Processing lock timeout - releasing", "warn");
        isProcessing = false;
      }
    }, 10000);

    const queryText = foundQuestion.structure.query ? stripHtml(foundQuestion.structure.query.text || "") : "";
    log(`New question: "${queryText.substring(0, 60)}" [${foundQuestion.type}]`);

    tryHighlightWithRetry(foundQuestion, currentId).then(() => {
      isProcessing = false;
      if (processingTimeout) {
        clearTimeout(processingTimeout);
        processingTimeout = null;
      }
    });
  } catch (err: any) {
    isProcessing = false;
    if (err.message && !err.message.includes("Could not retrieve") && !err.message.includes("Could not find")) {
      log(`Error: ${err.message}`, "warn");
    }
  }
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
      <span id="way-danz-title">Way-Danz v4.0</span>
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
      width: 280px;
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
    #way-danz-status.error { color: #FF5252; }
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

  makeDraggable(panel, panel.querySelector("#way-danz-header")! as HTMLElement);

  panel.querySelector("#way-danz-minimize")!.addEventListener("click", () => {
    panel.classList.toggle("minimized");
  });

  panel.querySelector("#way-danz-auto-answer")!.addEventListener("change", (e: Event) => {
    CONFIG.autoAnswer = (e.target as HTMLInputElement).checked;
    log(`Auto-answer: ${CONFIG.autoAnswer ? "ON" : "OFF"}`);
  });

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

const updatePanelStatus = (status: string, active: boolean = false, error: boolean = false) => {
  if (!panelElement) return;
  const el = panelElement.querySelector("#way-danz-status");
  if (el) {
    el.textContent = status;
    el.className = error ? "error" : (active ? "active" : "");
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
  if (answerEl) {
    const answerData = buildAnswerData(question);
    if (answerData.blankAnswerTexts.length > 0) {
      answerEl.textContent = answerData.blankAnswerTexts.join(" / ");
    } else if (answerData.texts.length > 0) {
      answerEl.textContent = answerData.rawTexts.length > 0 ? answerData.rawTexts.join(" | ") : answerData.texts.join(" | ");
    } else if (answerData.hasImageOptions && answerData.correctImageUrls.length > 0) {
      answerEl.textContent = `Image option ${answerData.correctIndices.map(i => i + 1).join(", ")}`;
    } else {
      answerEl.textContent = "No answer data available";
    }
  }
};

const showAnswerInPanel = (question: QuizQuestion) => {
  if (!panelElement) return;
  const answerEl = panelElement.querySelector("#way-danz-answer-display");
  if (answerEl) {
    const answerData = buildAnswerData(question);

    if (answerData.blankAnswerTexts.length > 0) {
      answerEl.textContent = `[${question.type}] ${answerData.blankAnswerTexts.join(" / ")}`;
      return;
    }

    if (answerData.texts.length > 0) {
      answerEl.textContent = `[${question.type}] ${answerData.rawTexts.length > 0 ? answerData.rawTexts.join(" | ") : answerData.texts.join(" | ")}`;
    } else if (answerData.hasImageOptions && answerData.correctImageUrls.length > 0) {
      answerEl.textContent = `[${question.type}] Image option ${answerData.correctIndices.map(i => i + 1).join(", ")}`;
    } else {
      answerEl.textContent = `[${question.type}] No answer data available`;
    }
  }
};

const updateStats = () => {
  if (!panelElement) return;
  const el = panelElement.querySelector("#way-danz-stats");
  if (el) {
    el.textContent = `Questions answered: ${statsTotal} | Highlighted: ${statsCorrect}`;
  }
};

// ═══════════════════════════════════════════════════════
//  LOGGING
// ═══════════════════════════════════════════════════════

const log = (message: string, level: "info" | "warn" | "error" = "info") => {
  const prefix = "[Way-Danz v4.0]";
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
  Wayground Cheat Engine v4.0
  https://github.com/Danz-Pro/Way-Danz
  `;
  console.log(banner, "color: #00E676; font-weight: bold; font-size: 12px;");

  createPanel();
  updatePanelStatus("Connecting...", false);

  try {
    let attempts = 0;
    const maxWait = 30;

    while (!isInGame() && attempts < maxWait) {
      updatePanelStatus(`Waiting for game... (${attempts + 1}s)`);
      await new Promise((r) => setTimeout(r, 1000));
      attempts++;
    }

    if (!isInGame()) {
      updatePanelStatus("No active game found. Join a game first!", false, true);
      log("No active game found. Please join a game first.");
      isRunning = false;
      return;
    }

    updatePanelStatus("Fetching quiz data...", false);
    const success = await fetchQuizData();

    if (!success) {
      updatePanelStatus("Failed to load quiz data!", false, true);
      log("Failed to load quiz data from all sources", "error");
      isRunning = false;
      return;
    }

    const qCount = cachedQuestions.size;
    updatePanelStatus(`Active - ${qCount} questions loaded`, true);
    log(`Script loaded! ${qCount} questions ready.`);

    setupMutationObserver();

    pollTimer = setInterval(() => {
      checkQuestionChange();
    }, CONFIG.pollInterval);

    // Initial check with delay for DOM to render
    setTimeout(() => {
      checkQuestionChange();
    }, 800);

    // Also re-check quiz data periodically in case it wasn't available initially
    // (e.g., quizId might become available after game starts)
    let refetchCount = 0;
    const refetchInterval = setInterval(async () => {
      refetchCount++;
      if (refetchCount > 5) {
        clearInterval(refetchInterval);
        return;
      }

      // If we have very few valid answers, try refetching
      let validAnswers = 0;
      cachedQuestions.forEach((q) => {
        const ad = buildAnswerData(q);
        if (ad.texts.length > 0 || ad.correctImageUrls.length > 0 || ad.blankAnswerTexts.length > 0) {
          validAnswers++;
        }
      });

      if (validAnswers < cachedQuestions.size * 0.5) {
        log(`Only ${validAnswers}/${cachedQuestions.size} answers valid, trying refetch...`, "warn");
        try {
          await fetchQuizData();
          const newValid = Array.from(cachedQuestions.values()).filter(q => {
            const ad = buildAnswerData(q);
            return ad.texts.length > 0 || ad.correctImageUrls.length > 0 || ad.blankAnswerTexts.length > 0;
          }).length;
          log(`Refetch: ${newValid}/${cachedQuestions.size} answers now valid`);
          if (newValid > validAnswers) {
            updatePanelStatus(`Active - ${cachedQuestions.size} questions (${newValid} with answers)`, true);
          }
        } catch {
          // Ignore refetch errors
        }
      } else {
        clearInterval(refetchInterval);
      }
    }, 5000);

  } catch (err: any) {
    updatePanelStatus(`Error: ${err.message}`, false, true);
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
  if (processingTimeout) {
    clearTimeout(processingTimeout);
    processingTimeout = null;
  }
  clearPreviousHighlights();
  if (panelElement) {
    panelElement.remove();
    panelElement = null;
  }
  isRunning = false;
  isProcessing = false;
  observerIsPaused = false;
  cachedQuestions.clear();
  questionsLoaded = false;
  lastQuestionID = undefined;
  lastHighlightedElements = [];
  statsCorrect = 0;
  statsTotal = 0;
  log("Stopped");
};

// ═══════════════════════════════════════════════════════
//  GLOBAL API
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
  getCachedQuestions: () => cachedQuestions,
  refetch: fetchQuizData,
};

// Auto-start
startCheat();
