const STORAGE_KEY = "exam7-flashcards-state-v1";
const DECK_URL = "./data/deck.json";
const DAY_MS = 24 * 60 * 60 * 1000;
const LEARNING_STEP_MS = 10 * 60 * 1000;

const FSRS6 = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194,
  0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483,
  0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];

const MODE_LABELS = {
  new: "新卡片",
  learning: "學習中",
  review: "複習中",
  all: "全部",
};

const MODE_ORDER = ["new", "learning", "review", "all"];
const GRADE = {
  again: 1,
  hard: 2,
  good: 3,
  easy: 4,
};

const app = document.querySelector("#app");

const state = {
  deck: null,
  progress: null,
  mode: "new",
  queue: [],
  currentIndex: 0,
  flipped: false,
  loading: true,
  error: null,
};

let memoryStorage = {};

init().catch((error) => {
  console.error(error);
  renderError(error);
});

async function init() {
  state.deck = await loadDeck();
  state.progress = loadProgress(state.deck);
  state.mode = state.progress.settings.lastMode ?? "new";
  state.loading = false;
  rebuildQueue();
  render();
  bindGlobalEvents();
}

async function loadDeck() {
  if (typeof window !== "undefined" && window.__DECK_DATA__) {
    return window.__DECK_DATA__;
  }

  const response = await fetch(DECK_URL, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Unable to load deck data from ${DECK_URL}`);
  }
  return response.json();
}

function defaultProgress(deck) {
  const cards = {};
  for (const card of deck.cards) {
    cards[String(card.cardId)] = {
      cardId: card.cardId,
      phase: "new",
      stability: null,
      difficulty: null,
      dueAt: null,
      lastReviewedAt: null,
      intervalDays: 0,
      reps: 0,
      lapses: 0,
      orderIndex: card.orderIndex,
    };
  }

  return {
    version: 1,
    settings: {
      desiredRetention: 0.9,
      learningStepMinutes: 10,
      lastMode: "new",
      scheduler: "fsrs-6",
    },
    cards,
    reviewLog: [],
  };
}

function loadProgress(deck) {
  const raw = safeStorageGet(STORAGE_KEY);
  if (!raw) {
    return defaultProgress(deck);
  }

  try {
    const parsed = JSON.parse(raw);
    const baseline = defaultProgress(deck);
    const merged = {
      ...baseline,
      ...parsed,
      settings: { ...baseline.settings, ...(parsed.settings ?? {}) },
      cards: { ...baseline.cards, ...(parsed.cards ?? {}) },
      reviewLog: Array.isArray(parsed.reviewLog) ? parsed.reviewLog : [],
    };

    for (const card of deck.cards) {
      const key = String(card.cardId);
      if (!merged.cards[key]) {
        merged.cards[key] = { ...baseline.cards[key] };
      } else {
        merged.cards[key] = {
          ...baseline.cards[key],
          ...merged.cards[key],
          cardId: card.cardId,
          orderIndex: card.orderIndex,
        };
      }
    }

    return merged;
  } catch {
    return defaultProgress(deck);
  }
}

function saveProgress() {
  safeStorageSet(STORAGE_KEY, JSON.stringify(state.progress));
}

function rebuildQueue() {
  const now = Date.now();
  const cards = state.deck.cards
    .map((card) => {
      const progress = getCardProgress(card.cardId);
      return {
        ...card,
        progress,
        phaseBucket: phaseBucket(progress.phase),
        isDue: isDue(progress, now),
      };
    })
    .filter((card) => isCardVisibleInMode(card, state.mode, now));

  cards.sort((a, b) => a.orderIndex - b.orderIndex);

  state.queue = cards;
  state.currentIndex = clamp(state.currentIndex, 0, Math.max(cards.length - 1, 0));
  if (cards.length === 0) {
    state.currentIndex = 0;
    state.flipped = false;
  }
}

function getCardProgress(cardId) {
  return state.progress.cards[String(cardId)];
}

function phaseBucket(phase) {
  if (phase === "learning" || phase === "relearning") {
    return "learning";
  }
  if (phase === "review") {
    return "review";
  }
  return "new";
}

function isDue(progress, now) {
  if (progress.phase === "new") {
    return true;
  }
  if (progress.dueAt == null) {
    return true;
  }
  return progress.dueAt <= now;
}

function isCardVisibleInMode(card, mode, now) {
  const bucket = card.phaseBucket;
  if (mode === "all") {
    return true;
  }
  if (mode === "new") {
    return bucket === "new";
  }
  if (mode === "learning") {
    return bucket === "learning";
  }
  if (mode === "review") {
    return bucket === "review";
  }
  return bucket === mode;
}

function counts() {
  const result = {
    new: 0,
    learning: 0,
    review: 0,
    due: 0,
  };
  const now = Date.now();
  for (const card of state.deck.cards) {
    const progress = getCardProgress(card.cardId);
    const bucket = phaseBucket(progress.phase);
    result[bucket] += 1;
    if (isDue(progress, now) && bucket !== "new") {
      result.due += 1;
    }
  }
  return result;
}

function currentCard() {
  return state.queue[state.currentIndex] ?? null;
}

function currentCardLabel(card) {
  if (!card) {
    return "No card";
  }
  const total = state.deck.cards.length;
  return `卡片 ${card.orderIndex + 1} / ${total}`;
}

function modeDetails(mode, totalCounts, totalCards) {
  if (mode === "new") {
    return `${totalCounts.new} 張新卡`;
  }
  if (mode === "learning") {
    return `${totalCounts.learning} 張學習中卡`;
  }
  if (mode === "review") {
    return `${totalCounts.review} 張複習中卡`;
  }
  return `${totalCards} 張總卡`;
}

function render() {
  if (state.loading) {
    app.innerHTML = loadingMarkup();
    return;
  }

  const totalCounts = counts();
  const card = currentCard();
  const modeLabel = MODE_LABELS[state.mode];
  const cardCount = state.queue.length;

  app.innerHTML = `
    <div class="top-bar">
      <div class="deck-title-row">
        <div>
          <div class="deck-title">${escapeHtml(state.deck.meta.deckName)}</div>
          <div class="deck-subtitle">按原始 Anki 順序學習，深色手機介面，FSRS-6 排程。</div>
        </div>
        <button class="settings-button" id="reset-progress" type="button" aria-label="重置學習進度">重置</button>
      </div>

      <div class="status-row" role="tablist" aria-label="學習模式">
        ${MODE_ORDER.map((mode) => {
          const active = state.mode === mode;
          return `<button class="mode-button" type="button" data-mode="${mode}" aria-pressed="${active}">${MODE_LABELS[mode]}</button>`;
        }).join("")}
      </div>

      <div class="metrics-card">
        <div class="metric">
          <div class="metric-label">新卡片</div>
          <div class="metric-value">${totalCounts.new}</div>
          <div class="metric-note">原始順序保持不變</div>
        </div>
        <div class="metric">
          <div class="metric-label">學習中</div>
          <div class="metric-value">${totalCounts.learning}</div>
          <div class="metric-note">顯示學習中卡片</div>
        </div>
        <div class="metric">
          <div class="metric-label">複習中</div>
          <div class="metric-value">${totalCounts.review}</div>
          <div class="metric-note">顯示複習中卡片</div>
        </div>
      </div>
    </div>

    <main class="deck-stage">
      ${card ? renderCard(card, cardCount, modeLabel, totalCounts) : renderEmptyState()}
    </main>

    <div class="footer-row">
      <div>${modeDetails(state.mode, totalCounts, state.deck.cards.length)}</div>
      <div>FSRS desired retention 90%</div>
    </div>
  `;

  attachHandlers();
}

function renderCard(card, cardCount, modeLabel, totalCounts) {
  const progress = getCardProgress(card.cardId);
  const dueText = progress.phase === "new"
    ? "新卡片"
    : progress.dueAt
      ? formatRelativeDue(progress.dueAt)
      : "尚未排程";
  const answerEnabled = state.flipped;
  const phaseText = phaseLabel(progress.phase);

  return `
    <section class="card-shell">
      <div class="card-meta">
        <div class="card-badge">${escapeHtml(modeLabel)} · ${escapeHtml(phaseText)}</div>
        <div>${escapeHtml(currentCardLabel(card))}</div>
      </div>

      <div class="card-wrap">
        <button class="card" id="flashcard" type="button" aria-label="翻轉卡片">
          <div class="card-face">
            <div class="card-face-inner">${state.flipped ? renderCardFace(card, "back") : renderCardFace(card, "front")}</div>
          </div>
          <div class="card-footer">
            <div class="card-flip-hint">${state.flipped ? "已翻面，請選擇評分" : "點一下卡片查看答案"}</div>
            <div class="pill-row">
              <span class="pill"><strong>${cardCount}</strong> 張在這個模式</span>
              <span class="pill">${escapeHtml(dueText)}</span>
            </div>
          </div>
        </button>
      </div>

      <div class="answer-bar">
        <button class="action-button action-again" type="button" data-rate="again" ${answerEnabled ? "" : "disabled"}>Again</button>
        <button class="action-button action-hard" type="button" data-rate="hard" ${answerEnabled ? "" : "disabled"}>Hard</button>
        <button class="action-button action-good" type="button" data-rate="good" ${answerEnabled ? "" : "disabled"}>Good</button>
        <button class="action-button action-easy" type="button" data-rate="easy" ${answerEnabled ? "" : "disabled"}>Easy</button>
      </div>
    </section>
  `;
}

function renderCardFace(card, side) {
  const html = side === "front" ? card.frontHtml : card.backHtml;
  return html || `<div class="card-placeholder">No ${side} content</div>`;
}

function renderEmptyState() {
  const totalCounts = counts();
  const message = state.mode === "new"
    ? "目前沒有新卡片。"
    : state.mode === "learning"
      ? "目前沒有學習中卡片。"
      : state.mode === "review"
        ? "目前沒有複習中卡片。"
        : "目前沒有可顯示的卡片。";

  return `
    <section class="empty-state">
      <div class="empty-kicker">Flashcard queue</div>
      <div class="empty-title">${escapeHtml(message)}</div>
      <div class="empty-subtitle">
        你可以切換模式，或回到「全部」查看整個牌組的原始順序。
      </div>
      <div class="pill-row" style="justify-content:center; margin-top:18px;">
        <span class="pill"><strong>${totalCounts.new}</strong> 新卡</span>
        <span class="pill"><strong>${totalCounts.learning}</strong> 學習中</span>
        <span class="pill"><strong>${totalCounts.review}</strong> 複習中</span>
      </div>
    </section>
  `;
}

function loadingMarkup() {
  return `
    <div class="loading-state">
      <div class="loading-kicker">Exam 7 Flashcards</div>
      <div class="loading-title">Preparing your deck…</div>
      <div class="loading-subtitle">正在載入 Anki deck 與本機進度。</div>
    </div>
  `;
}

function renderError(error) {
  app.innerHTML = `
    <div class="empty-state">
      <div class="empty-kicker">Error</div>
      <div class="empty-title">無法啟動 app</div>
      <div class="empty-subtitle">${escapeHtml(error?.message ?? "Unknown error")}</div>
    </div>
  `;
}

function attachHandlers() {
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextMode = button.dataset.mode;
      if (!nextMode || nextMode === state.mode) {
        return;
      }
      state.mode = nextMode;
      state.progress.settings.lastMode = nextMode;
      state.currentIndex = 0;
      state.flipped = false;
      saveProgress();
      rebuildQueue();
      render();
    });
  });

  document.querySelector("#flashcard")?.addEventListener("click", () => {
    state.flipped = !state.flipped;
    render();
  });

  document.querySelectorAll("[data-rate]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!state.flipped) {
        return;
      }
      handleReview(button.dataset.rate);
    });
  });

  document.querySelector("#reset-progress")?.addEventListener("click", () => {
    if (!confirm("確定要重置所有學習進度嗎？")) {
      return;
    }
    state.progress = defaultProgress(state.deck);
    state.mode = "new";
    state.currentIndex = 0;
    state.flipped = false;
    saveProgress();
    rebuildQueue();
    render();
  });
}

function bindGlobalEvents() {
  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) {
      return;
    }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      state.flipped = !state.flipped;
      render();
      return;
    }
    if (!state.flipped) {
      return;
    }
    if (event.key === "1") {
      handleReview("again");
    } else if (event.key === "2") {
      handleReview("hard");
    } else if (event.key === "3") {
      handleReview("good");
    } else if (event.key === "4") {
      handleReview("easy");
    }
  });
}

function handleReview(rateKey) {
  const card = currentCard();
  if (!card) {
    return;
  }

  const rating = GRADE[rateKey];
  if (!rating) {
    return;
  }

  const progress = getCardProgress(card.cardId);
  const now = Date.now();
  const before = structuredClone(progress);
  const reviewedOrderIndex = card.orderIndex;
  const next = applyReview(before, rating, now);
  state.progress.cards[String(card.cardId)] = next;
  state.progress.reviewLog.push({
    id: crypto.randomUUID(),
    cardId: card.cardId,
    deckCardId: card.cardId,
    orderIndex: card.orderIndex,
    rating,
    mode: state.mode,
    phaseBefore: before.phase,
    phaseAfter: next.phase,
    timestamp: now,
    lastReviewedAt: before.lastReviewedAt,
    dueAtBefore: before.dueAt,
    dueAtAfter: next.dueAt,
    intervalDaysBefore: before.intervalDays ?? 0,
    intervalDaysAfter: next.intervalDays ?? 0,
    stabilityBefore: before.stability,
    stabilityAfter: next.stability,
    difficultyBefore: before.difficulty,
    difficultyAfter: next.difficulty,
  });
  state.progress.settings.lastCardId = card.cardId;
  saveProgress();
  state.flipped = false;
  rebuildQueue();
  moveToNextCard(reviewedOrderIndex);
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  render();
  requestAnimationFrame(() => {
    window.scrollTo({ left: scrollX, top: scrollY, behavior: "auto" });
  });
}

function moveToNextCard(reviewedOrderIndex) {
  if (state.queue.length === 0) {
    state.currentIndex = 0;
    return;
  }
  const nextIndex = state.queue.findIndex((item) => item.orderIndex > reviewedOrderIndex);
  state.currentIndex = nextIndex >= 0 ? nextIndex : 0;
}

function applyReview(previous, rating, now) {
  const desiredRetention = Number(state.progress.settings.desiredRetention) || 0.9;
  const learningStepMinutes = Number(state.progress.settings.learningStepMinutes) || 10;
  const learningStepMs = learningStepMinutes * 60 * 1000;
  const elapsedDays = Math.max(0.0001, ((now - (previous.lastReviewedAt ?? now)) / DAY_MS));
  const previousStability = Math.max(previous.stability ?? initialStability(rating), 0.01);
  const previousDifficulty = clamp(previous.difficulty ?? initialDifficulty(rating), 1, 10);

  let next = { ...previous };
  next.reps = (previous.reps ?? 0) + 1;
  next.lastReviewedAt = now;
  next.orderIndex = previous.orderIndex ?? next.orderIndex;

  if (previous.phase === "new") {
    if (rating === GRADE.again) {
      next.phase = "learning";
      next.stability = initialStability(rating);
      next.difficulty = initialDifficulty(rating);
      next.intervalDays = 0;
      next.dueAt = now + learningStepMs;
      return next;
    }

    next.phase = "review";
    next.stability = initialStability(rating);
    next.difficulty = initialDifficulty(rating);
    next.intervalDays = Math.max(1 / 1440, intervalForRetention(next.stability, desiredRetention));
    next.dueAt = now + next.intervalDays * DAY_MS;
    return next;
  }

  if (previous.phase === "learning" || previous.phase === "relearning") {
    if (rating === GRADE.again) {
      next.phase = previous.phase;
      next.stability = Math.max(previousStability * 0.8, 0.01);
      next.difficulty = updateDifficulty(previousDifficulty, rating);
      next.intervalDays = 0;
      next.dueAt = now + learningStepMs;
      return next;
    }

    next.phase = "review";
    const updatedDifficulty = updateDifficulty(previousDifficulty, rating);
    const sameDayStability = sameDayReviewStability(previousStability, rating);
    next.stability = Math.max(sameDayStability, previousStability);
    next.difficulty = updatedDifficulty;
    next.intervalDays = Math.max(1 / 1440, intervalForRetention(next.stability, desiredRetention));
    next.dueAt = now + next.intervalDays * DAY_MS;
    return next;
  }

  if (rating === GRADE.again) {
    const retrievability = getRetrievability(elapsedDays, previousStability);
    next.phase = "relearning";
    next.stability = Math.max(stabilityAfterForget(previousDifficulty, previousStability, retrievability), 0.01);
    next.difficulty = updateDifficulty(previousDifficulty, rating);
    next.lapses = (previous.lapses ?? 0) + 1;
    next.intervalDays = 0;
    next.dueAt = now + learningStepMs;
    return next;
  }

  const retrievability = getRetrievability(elapsedDays, previousStability);
  const updatedDifficulty = updateDifficulty(previousDifficulty, rating);
  const updatedStability = stabilityAfterRecall(updatedDifficulty, previousStability, retrievability, rating);

  next.phase = "review";
  next.stability = Math.max(updatedStability, previousStability);
  next.difficulty = updatedDifficulty;
  next.intervalDays = Math.max(1 / 1440, intervalForRetention(next.stability, desiredRetention));
  next.dueAt = now + next.intervalDays * DAY_MS;
  return next;
}

function initialStability(rating) {
  return Math.max(FSRS6[rating - 1] ?? FSRS6[2], 0.01);
}

function initialDifficulty(rating) {
  const d0 = FSRS6[4] - Math.exp(FSRS6[5] * (rating - 1)) + 1;
  return clamp(d0, 1, 10);
}

function updateDifficulty(previousDifficulty, rating) {
  const deltaD = -FSRS6[6] * (rating - 3);
  const damped = previousDifficulty + deltaD * ((10 - previousDifficulty) / 9);
  const meanReverted = FSRS6[7] * initialDifficulty(4) + (1 - FSRS6[7]) * damped;
  return clamp(meanReverted, 1, 10);
}

function sameDayReviewStability(stability, rating) {
  const inc = Math.exp(FSRS6[17] * (rating - 3 + FSRS6[18])) * Math.pow(Math.max(stability, 0.01), -FSRS6[19]);
  const next = stability * inc;
  if (rating >= GRADE.good) {
    return Math.max(next, stability);
  }
  return Math.max(next, stability * 0.5);
}

function stabilityAfterRecall(difficulty, stability, retrievability, rating) {
  const base =
    Math.exp(FSRS6[8]) *
    (11 - difficulty) *
    Math.pow(Math.max(stability, 0.01), -FSRS6[9]) *
    (Math.exp(FSRS6[10] * (1 - retrievability)) - 1);

  const ratingMultiplier =
    rating === GRADE.hard ? FSRS6[15] :
    rating === GRADE.easy ? FSRS6[16] :
    1;

  const next = stability * (base * ratingMultiplier + 1);
  return Math.max(next, stability);
}

function stabilityAfterForget(difficulty, stability, retrievability) {
  const next =
    FSRS6[11] *
    Math.pow(difficulty, -FSRS6[12]) *
    (Math.pow(stability + 1, FSRS6[13]) - 1) *
    Math.exp(FSRS6[14] * (1 - retrievability));
  return Math.max(next, 0.01);
}

function getRetrievability(elapsedDays, stability) {
  const factor = Math.pow(0.9, -1 / FSRS6[20]) - 1;
  return Math.pow(1 + factor * (elapsedDays / Math.max(stability, 0.01)), -FSRS6[20]);
}

function intervalForRetention(stability, retention) {
  const clampedRetention = clamp(retention, 0.5, 0.995);
  const factor = Math.pow(0.9, -1 / FSRS6[20]) - 1;
  const interval = (stability / factor) * (Math.pow(clampedRetention, -1 / FSRS6[20]) - 1);
  return Math.max(interval, 1 / 1440);
}

function formatRelativeDue(timestamp) {
  const diff = timestamp - Date.now();
  if (diff <= 0) {
    return "已到期";
  }
  const minutes = Math.round(diff / 60000);
  if (minutes < 60) {
    return `${minutes} 分鐘後`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} 小時後`;
  }
  const days = Math.round(hours / 24);
  return `${days} 天後`;
}

function phaseLabel(phase) {
  if (phase === "new") {
    return "新卡片";
  }
  if (phase === "learning") {
    return "學習中";
  }
  if (phase === "relearning") {
    return "學習中";
  }
  return "複習中";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function safeStorageGet(key) {
  try {
    if (typeof localStorage !== "undefined") {
      const value = localStorage.getItem(key);
      if (value != null) {
        return value;
      }
    }
  } catch {
    // Fall back to in-memory storage for file:// or restricted browser contexts.
  }
  return memoryStorage[key] ?? null;
}

function safeStorageSet(key, value) {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(key, value);
      return;
    }
  } catch {
    // Ignore and use the in-memory fallback below.
  }
  memoryStorage[key] = value;
}
