const STORAGE_KEY = "exam7-flashcards-state-v1";
const DECK_URL = "./data/deck.json";
const DAY_MS = 24 * 60 * 60 * 1000;
const REVIEW_GROUPS = [10 * 60 * 1000, DAY_MS, 4 * DAY_MS, 10 * DAY_MS];
const NO_CARD = "__no_card__";
const SUMMARY_GROUPS = [
  { key: "new", label: "新卡片", note: "尚未開始" },
  { key: "review-0", label: "10分鐘群組", note: "第一輪複習" },
  { key: "review-1", label: "1天群組", note: "短期鞏固" },
  { key: "review-2", label: "4天群組", note: "中段記憶" },
  { key: "review-3", label: "10天群組", note: "長間隔複習" },
];

const MODE_LABELS = {
  new: "新卡片",
  review: "複習中",
  all: "全部",
};

const MODE_ORDER = ["new", "review", "all"];

const app = document.querySelector("#app");

const state = {
  deck: null,
  progress: null,
  mode: "new",
  queue: [],
  currentCardId: null,
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
  state.mode = normalizeMode(state.progress.settings.lastMode || "new");
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
      dueAt: null,
      lastReviewedAt: null,
      reviewStage: null,
      reps: 0,
      lapses: 0,
      orderIndex: card.orderIndex,
    };
  }

  return {
    version: 2,
    settings: {
      lastMode: "new",
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
      settings: { ...baseline.settings, ...(parsed.settings || {}) },
      cards: { ...baseline.cards, ...(parsed.cards || {}) },
      reviewLog: Array.isArray(parsed.reviewLog) ? parsed.reviewLog : [],
    };

    for (const card of deck.cards) {
      const key = String(card.cardId);
      if (!merged.cards[key]) {
        merged.cards[key] = { ...baseline.cards[key] };
      } else {
        const existing = merged.cards[key];
        merged.cards[key] = {
          ...baseline.cards[key],
          ...existing,
          cardId: card.cardId,
          orderIndex: card.orderIndex,
          phase: normalizePhase(existing.phase),
          reviewStage: normalizeReviewStage(existing),
        };
      }
    }

    merged.settings.lastMode = normalizeMode(merged.settings.lastMode);

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
  const cards = state.deck.cards.map((card) => {
    const progress = getCardProgress(card.cardId);
    const phase = phaseBucket(progress.phase);
    return {
      ...card,
      progress,
      phaseBucket: phase,
      isDue: isDue(progress, now),
      reviewStage: getReviewStage(progress),
    };
  });

  const newCards = cards
    .filter((card) => card.phaseBucket === "new")
    .sort((a, b) => a.orderIndex - b.orderIndex);
  const reviewCards = cards
    .filter((card) => card.phaseBucket === "review")
    .sort((a, b) => {
      const dueA = a.progress.dueAt != null ? a.progress.dueAt : Number.POSITIVE_INFINITY;
      const dueB = b.progress.dueAt != null ? b.progress.dueAt : Number.POSITIVE_INFINITY;
      return dueA - dueB || a.orderIndex - b.orderIndex;
    });
  const dueReviewCards = reviewCards.filter((card) => card.isDue);

  if (state.mode === "new") {
    state.queue = newCards;
  } else if (state.mode === "review") {
    state.queue = reviewCards;
  } else if (dueReviewCards.length > 0) {
    state.queue = dueReviewCards;
  } else if (newCards.length > 0) {
    state.queue = newCards;
  } else {
    state.queue = reviewCards;
  }

  if (state.queue.length === 0) {
    state.currentCardId = NO_CARD;
    return;
  }

  if (state.currentCardId === NO_CARD || state.currentCardId == null || !state.queue.some((card) => card.cardId === state.currentCardId)) {
    state.currentCardId = state.queue[0].cardId;
  }
}

function getCardProgress(cardId) {
  return state.progress.cards[String(cardId)];
}

function phaseBucket(phase) {
  if (phase === "new") {
    return "new";
  }
  return "review";
}

function normalizePhase(phase) {
  return phase === "new" ? "new" : "review";
}

function normalizeMode(mode) {
  if (mode === "review" || mode === "all") {
    return mode;
  }
  return "new";
}

function normalizeReviewStage(progress) {
  if (!progress || progress.phase === "new") {
    return null;
  }
  if (Number.isFinite(progress.reviewStage)) {
    return clamp(Math.trunc(progress.reviewStage), 0, REVIEW_GROUPS.length - 1);
  }
  const intervalMs =
    Number.isFinite(progress.intervalDays)
      ? Math.max(0, progress.intervalDays * DAY_MS)
      : Number.isFinite(progress.dueAt) && Number.isFinite(progress.lastReviewedAt)
        ? Math.max(0, progress.dueAt - progress.lastReviewedAt)
        : null;
  if (intervalMs == null) {
    return 0;
  }
  return inferReviewStageFromInterval(intervalMs);
}

function getReviewStage(progress) {
  if (!progress || progress.phase === "new") {
    return null;
  }
  if (Number.isFinite(progress.reviewStage)) {
    return clamp(Math.trunc(progress.reviewStage), 0, REVIEW_GROUPS.length - 1);
  }
  const stage = normalizeReviewStage(progress);
  return stage == null ? 0 : stage;
}

function inferReviewStageFromInterval(intervalMs) {
  const thresholds = [
    (REVIEW_GROUPS[0] + REVIEW_GROUPS[1]) / 2,
    (REVIEW_GROUPS[1] + REVIEW_GROUPS[2]) / 2,
    (REVIEW_GROUPS[2] + REVIEW_GROUPS[3]) / 2,
  ];
  if (intervalMs <= thresholds[0]) {
    return 0;
  }
  if (intervalMs <= thresholds[1]) {
    return 1;
  }
  if (intervalMs <= thresholds[2]) {
    return 2;
  }
  return 3;
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

function reviewStageLabel(stage) {
  if (stage == null) {
    return "複習中";
  }
  return ["倒數10分鐘", "倒數1天", "倒數4天", "倒數10天"][stage] || "複習中";
}

function cardScheduleLabel(progress) {
  if (progress.phase === "new") {
    return "新卡片";
  }
  const stage = getReviewStage(progress);
  const label = reviewStageLabel(stage);
  if (!progress.dueAt) {
    return label;
  }
  return `${label} · ${formatRelativeDue(progress.dueAt)}`;
}

function counts() {
  const result = {
    new: 0,
    review: 0,
    due: 0,
  };
  const now = Date.now();
  for (const card of state.deck.cards) {
    const progress = getCardProgress(card.cardId);
    const bucket = phaseBucket(progress.phase);
    result[bucket] += 1;
    if (isDue(progress, now) && bucket === "review") {
      result.due += 1;
    }
  }
  return result;
}

function summaryCounts() {
  const totalCards = state.deck.cards.length;
  const groups = SUMMARY_GROUPS.map((group) => ({
    ...group,
    count: 0,
    percent: 0,
  }));
  const groupIndex = new Map(groups.map((group, index) => [group.key, index]));

  for (const card of state.deck.cards) {
    const progress = getCardProgress(card.cardId);
    const key = progress.phase === "new" ? "new" : `review-${getReviewStage(progress)}`;
    const index = groupIndex.get(key);
    if (index != null) {
      groups[index].count += 1;
    }
  }

  for (const group of groups) {
    group.percent = totalCards > 0 ? (group.count / totalCards) * 100 : 0;
  }

  return {
    totalCards,
    groups,
  };
}

function currentCard() {
  if (state.currentCardId === NO_CARD) {
    return null;
  }
  if (state.currentCardId != null) {
    const selected = state.queue.find((card) => card.cardId === state.currentCardId);
    if (selected) {
      return selected;
    }
  }
  return state.queue[0] || null;
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
  const summary = summaryCounts();
  const card = currentCard();
  const modeLabel = MODE_LABELS[state.mode];
  const cardCount = state.queue.length;

  app.innerHTML = `
    <div class="top-bar">
      <div class="deck-title-row">
        <div>
          <div class="deck-title">${escapeHtml(state.deck.meta.deckName)}</div>
          <div class="deck-subtitle">新卡片、複習中與全部三種模式，使用固定 10 分鐘 / 1 天 / 4 天 / 10 天排程。</div>
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
        <div class="metrics-overview">
          <div>
            <div class="metrics-overview-label">卡片分布</div>
            <div class="metrics-overview-value">${summary.totalCards}</div>
            <div class="metrics-overview-note">依新卡與 4 個複習群組統計目前牌組</div>
          </div>
          <div class="metrics-overview-chip">總數 100%</div>
        </div>
        <div class="metrics-grid">
          ${summary.groups.map((group) => `
            <article class="metric metric-${group.key}">
              <div class="metric-topline">
                <div class="metric-label">${group.label}</div>
                <div class="metric-percent">${formatPercent(group.percent)}</div>
              </div>
              <div class="metric-value">${group.count}</div>
              <div class="metric-bar" aria-hidden="true">
                <span style="width:${group.percent.toFixed(2)}%"></span>
              </div>
              <div class="metric-note">${group.note}</div>
            </article>
          `).join("")}
        </div>
      </div>
    </div>

    <main class="deck-stage">
      ${card ? renderCard(card, cardCount, modeLabel, totalCounts) : renderEmptyState()}
    </main>

    <div class="footer-row">
      <div>${modeDetails(state.mode, totalCounts, state.deck.cards.length)}</div>
      <div>10 分鐘 → 1 天 → 4 天 → 10 天</div>
    </div>
  `;

  attachHandlers();
}

function renderCard(card, cardCount, modeLabel, totalCounts) {
  const progress = getCardProgress(card.cardId);
  const dueText = cardScheduleLabel(progress);
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
        <button class="action-button action-bad" type="button" data-rate="bad" ${answerEnabled ? "" : "disabled"}>BAD</button>
        <button class="action-button action-good" type="button" data-rate="good" ${answerEnabled ? "" : "disabled"}>GOOD</button>
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
    : state.mode === "review"
      ? "目前沒有複習中卡片。"
      : "目前沒有可顯示的卡片。";

  return `
    <section class="empty-state">
      <div class="empty-kicker">Flashcard queue</div>
      <div class="empty-title">${escapeHtml(message)}</div>
      <div class="empty-subtitle">
        你可以切換模式，或稍後再回來看看到期卡片。
      </div>
      <div class="pill-row" style="justify-content:center; margin-top:18px;">
        <span class="pill"><strong>${totalCounts.new}</strong> 新卡</span>
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

function formatPercent(value) {
  if (value === 0) {
    return "0%";
  }
  if (value >= 10) {
    return `${Math.round(value)}%`;
  }
  return `${value.toFixed(1)}%`;
}

function renderError(error) {
  app.innerHTML = `
    <div class="empty-state">
      <div class="empty-kicker">Error</div>
      <div class="empty-title">無法啟動 app</div>
      <div class="empty-subtitle">${escapeHtml(error && error.message ? error.message : "Unknown error")}</div>
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
      state.mode = normalizeMode(nextMode);
      state.progress.settings.lastMode = state.mode;
      state.currentCardId = null;
      state.flipped = false;
      saveProgress();
      rebuildQueue();
      render();
    });
  });

  const flashcard = document.querySelector("#flashcard");
  if (flashcard) {
    flashcard.addEventListener("click", () => {
      state.flipped = !state.flipped;
      render();
    });
  }

  document.querySelectorAll("[data-rate]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!state.flipped) {
        return;
      }
      handleReview(button.dataset.rate);
    });
  });

  const resetButton = document.querySelector("#reset-progress");
  if (resetButton) {
    resetButton.addEventListener("click", () => {
      if (!confirm("確定要重置所有學習進度嗎？")) {
        return;
      }
      state.progress = defaultProgress(state.deck);
      state.mode = "new";
      state.currentCardId = null;
      state.flipped = false;
      saveProgress();
      rebuildQueue();
      render();
    });
  }
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
      handleReview("bad");
    } else if (event.key === "2") {
      handleReview("good");
    }
  });
}

function handleReview(rateKey) {
  const card = currentCard();
  if (!card) {
    return;
  }

  if (rateKey !== "bad" && rateKey !== "good") {
    return;
  }

  const progress = getCardProgress(card.cardId);
  const now = Date.now();
  const before = cloneProgress(progress);
  const next = applyReview(before, rateKey, now);
  state.progress.cards[String(card.cardId)] = next;
  state.progress.reviewLog.push({
    id: generateId(),
    cardId: card.cardId,
    deckCardId: card.cardId,
    orderIndex: card.orderIndex,
    rating: rateKey,
    mode: state.mode,
    phaseBefore: before.phase,
    phaseAfter: next.phase,
    reviewStageBefore: before.reviewStage != null ? before.reviewStage : null,
    reviewStageAfter: next.reviewStage != null ? next.reviewStage : null,
    timestamp: now,
    dueAtBefore: before.dueAt,
    dueAtAfter: next.dueAt,
    lastReviewedAtBefore: before.lastReviewedAt,
    lastReviewedAtAfter: next.lastReviewedAt,
  });
  saveProgress();
  state.flipped = false;
  rebuildQueue();
  moveToNextCard(card.cardId);
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  render();
  requestAnimationFrame(() => {
    window.scrollTo({ left: scrollX, top: scrollY, behavior: "auto" });
  });
}

function moveToNextCard(reviewedCardId) {
  if (state.queue.length === 0) {
    state.currentCardId = NO_CARD;
    return;
  }

  const nextCard = state.queue.find((item) => item.cardId !== reviewedCardId);
  if (nextCard) {
    state.currentCardId = nextCard.cardId;
    return;
  }

  if (state.queue.some((item) => item.cardId === reviewedCardId)) {
    state.currentCardId = reviewedCardId;
    return;
  }

  state.currentCardId = state.queue[0] ? state.queue[0].cardId : NO_CARD;
}

function applyReview(previous, rating, now) {
  const next = { ...previous };
  next.reps = (previous.reps != null ? previous.reps : 0) + 1;
  next.lastReviewedAt = now;
  next.phase = "review";

  const currentStage = previous.phase === "new"
    ? null
    : getReviewStage(previous);

  let nextStage;
  if (previous.phase === "new") {
    nextStage = rating === "bad" ? 0 : 1;
  } else if (rating === "bad") {
    nextStage = 0;
  } else {
    nextStage = Math.min((currentStage != null ? currentStage : 0) + 1, REVIEW_GROUPS.length - 1);
  }

  next.reviewStage = nextStage;
  next.dueAt = now + REVIEW_GROUPS[nextStage];
  next.lapses = rating === "bad" ? (previous.lapses != null ? previous.lapses : 0) + 1 : (previous.lapses != null ? previous.lapses : 0);
  next.orderIndex = previous.orderIndex != null ? previous.orderIndex : next.orderIndex;
  return next;
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
  return Object.prototype.hasOwnProperty.call(memoryStorage, key) ? memoryStorage[key] : null;
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

function cloneProgress(progress) {
  return JSON.parse(JSON.stringify(progress));
}

function generateId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return "review-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}
