import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";

const DAY_MS = 24 * 60 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const APP_JS = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");

function makeDeck(cardCount) {
  return {
    meta: {
      deckName: "Test Deck",
    },
    cards: Array.from({ length: cardCount }, (_, index) => ({
      cardId: index + 1,
      orderIndex: index,
      frontHtml: `front ${index + 1}`,
      backHtml: `back ${index + 1}`,
    })),
  };
}

async function createApp(cardCount, now = 0) {
  const storage = new Map();
  const appElement = { innerHTML: "" };
  const noopElement = {
    addEventListener() {},
    dataset: {},
  };
  const context = {
    __now: now,
    console,
    crypto,
    Math,
    Number,
    JSON,
    Object,
    String,
    Array,
    Error,
    Promise,
    setTimeout,
    clearTimeout,
    requestAnimationFrame(callback) {
      callback();
    },
    confirm() {
      return true;
    },
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
    },
    document: {
      querySelector(selector) {
        return selector === "#app" ? appElement : noopElement;
      },
      querySelectorAll() {
        return [];
      },
    },
    window: {
      __DECK_DATA__: makeDeck(cardCount),
      scrollX: 0,
      scrollY: 0,
      addEventListener() {},
      scrollTo() {},
    },
  };
  context.globalThis = context;
  context.Date = class FakeDate extends Date {
    constructor(...args) {
      super(...(args.length > 0 ? args : [context.__now]));
    }

    static now() {
      return context.__now;
    }
  };

  vm.runInNewContext(
    `${APP_JS}\n` +
      "globalThis.__flashcardsTestApi = { state, REVIEW_GROUPS, rebuildQueue, handleReview, applyReview, getCardProgress, currentCard };",
    context,
    { filename: "app.js" },
  );

  await new Promise((resolve) => setTimeout(resolve, 0));

  const api = context.__flashcardsTestApi;
  return {
    api,
    setNow(value) {
      context.__now = value;
    },
    switchMode(mode) {
      api.state.mode = mode;
      api.state.currentCardId = null;
      api.state.flipped = false;
      api.rebuildQueue();
    },
    reviewCurrent(rating) {
      api.state.flipped = true;
      api.handleReview(rating);
    },
    reviewCard(cardId, rating) {
      api.state.currentCardId = cardId;
      api.state.flipped = true;
      api.handleReview(rating);
    },
    queueIds() {
      return api.state.queue.map((card) => card.cardId);
    },
    progress(cardId) {
      return api.getCardProgress(cardId);
    },
  };
}

function dueAt(progress) {
  assert.equal(progress.phase, "review");
  assert.equal(typeof progress.dueAt, "number");
  return progress.dueAt;
}

async function testNewCardsEnterReviewGroups() {
  const app = await createApp(4, 1000);

  assert.deepEqual(app.queueIds(), [1, 2, 3, 4]);

  app.reviewCurrent("bad");
  assert.equal(app.progress(1).phase, "review");
  assert.equal(app.progress(1).reviewStage, 0);
  assert.equal(dueAt(app.progress(1)), 1000 + TEN_MINUTES_MS);
  assert.deepEqual(app.queueIds(), [2, 3, 4]);

  app.reviewCurrent("good");
  assert.equal(app.progress(2).phase, "review");
  assert.equal(app.progress(2).reviewStage, 1);
  assert.equal(dueAt(app.progress(2)), 1000 + DAY_MS);
  assert.deepEqual(app.queueIds(), [3, 4]);
}

async function testReviewGoodAndBadTransitions() {
  const app = await createApp(1, 0);

  app.reviewCurrent("bad");
  app.switchMode("review");

  app.setNow(TEN_MINUTES_MS + 1);
  app.reviewCard(1, "good");
  assert.equal(app.progress(1).reviewStage, 1);
  assert.equal(dueAt(app.progress(1)), TEN_MINUTES_MS + 1 + DAY_MS);

  app.setNow(TEN_MINUTES_MS + 1 + DAY_MS + 1);
  app.reviewCard(1, "good");
  assert.equal(app.progress(1).reviewStage, 2);
  assert.equal(dueAt(app.progress(1)), TEN_MINUTES_MS + 1 + DAY_MS + 1 + 4 * DAY_MS);

  app.setNow(TEN_MINUTES_MS + 1 + DAY_MS + 1 + 4 * DAY_MS + 1);
  app.reviewCard(1, "good");
  assert.equal(app.progress(1).reviewStage, 3);
  assert.equal(dueAt(app.progress(1)), TEN_MINUTES_MS + 1 + DAY_MS + 1 + 4 * DAY_MS + 1 + 10 * DAY_MS);

  app.setNow(TEN_MINUTES_MS + 1 + DAY_MS + 1 + 4 * DAY_MS + 1 + 10 * DAY_MS + 1);
  app.reviewCard(1, "good");
  assert.equal(app.progress(1).reviewStage, 3);
  assert.equal(dueAt(app.progress(1)), TEN_MINUTES_MS + 1 + DAY_MS + 1 + 4 * DAY_MS + 1 + 10 * DAY_MS + 1 + 10 * DAY_MS);

  app.reviewCard(1, "bad");
  assert.equal(app.progress(1).reviewStage, 0);
  assert.equal(dueAt(app.progress(1)), TEN_MINUTES_MS + 1 + DAY_MS + 1 + 4 * DAY_MS + 1 + 10 * DAY_MS + 1 + TEN_MINUTES_MS);
}

async function testReviewQueueSortsByDueTime() {
  const app = await createApp(5, 0);
  const progress = app.api.state.progress.cards;
  progress["1"] = { ...progress["1"], phase: "review", dueAt: 10_000, reviewStage: 0 };
  progress["2"] = { ...progress["2"], phase: "review", dueAt: -50_000, reviewStage: 0 };
  progress["3"] = { ...progress["3"], phase: "review", dueAt: 0, reviewStage: 0 };
  progress["4"] = { ...progress["4"], phase: "review", dueAt: 10_000, reviewStage: 0 };
  progress["5"] = { ...progress["5"], phase: "new", dueAt: null, reviewStage: null };

  app.switchMode("review");
  assert.deepEqual(app.queueIds(), [2, 3, 1, 4]);
}

async function testAllModeDueNewReviewFallbacks() {
  const app = await createApp(4, 0);
  const progress = app.api.state.progress.cards;
  progress["1"] = { ...progress["1"], phase: "review", dueAt: -100, reviewStage: 0 };
  progress["2"] = { ...progress["2"], phase: "review", dueAt: 5_000, reviewStage: 0 };
  progress["3"] = { ...progress["3"], phase: "new", dueAt: null, reviewStage: null };
  progress["4"] = { ...progress["4"], phase: "new", dueAt: null, reviewStage: null };

  app.switchMode("all");
  assert.deepEqual(app.queueIds(), [1]);

  app.reviewCard(1, "bad");
  assert.deepEqual(app.queueIds(), [3, 4]);

  app.reviewCurrent("good");
  app.reviewCurrent("bad");
  assert.deepEqual(app.queueIds(), [2, 1, 4, 3]);
}

async function testAllModeShowsOnlyDueReviewCardsWhenAnyAreDue() {
  const app = await createApp(5, 10_000);
  const progress = app.api.state.progress.cards;
  progress["1"] = { ...progress["1"], phase: "review", dueAt: 10_000, reviewStage: 0 };
  progress["2"] = { ...progress["2"], phase: "review", dueAt: -10_000, reviewStage: 0 };
  progress["3"] = { ...progress["3"], phase: "review", dueAt: 20_000, reviewStage: 0 };
  progress["4"] = { ...progress["4"], phase: "new", dueAt: null, reviewStage: null };
  progress["5"] = { ...progress["5"], phase: "new", dueAt: null, reviewStage: null };

  app.switchMode("all");
  assert.deepEqual(app.queueIds(), [2, 1]);
}

async function testUserTwelveCardScenario() {
  const app = await createApp(12, 0);

  app.reviewCard(1, "bad");
  for (let cardId = 2; cardId <= 11; cardId += 1) {
    app.reviewCard(cardId, "good");
  }
  app.reviewCard(12, "bad");

  app.setNow(TEN_MINUTES_MS + 1);
  app.switchMode("review");
  app.reviewCard(1, "bad");

  assert.deepEqual(app.queueIds(), [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
}

async function testUserCrossSessionScenario() {
  const app = await createApp(8, 0);

  app.reviewCard(1, "good");
  app.setNow(DAY_MS + 1);
  app.switchMode("review");
  app.reviewCard(1, "good");

  app.setNow(DAY_MS + 1 + 3.5 * DAY_MS);
  app.switchMode("new");
  app.reviewCard(2, "good");
  app.reviewCard(3, "bad");

  app.setNow(DAY_MS + 1 + 3.5 * DAY_MS + 5 * 60 * 1000);
  app.reviewCard(4, "bad");

  app.setNow(DAY_MS + 1 + 3.5 * DAY_MS + 10 * 60 * 1000);
  app.switchMode("review");
  assert.deepEqual(app.queueIds(), [3, 4, 1, 2]);

  app.switchMode("all");
  assert.deepEqual(app.queueIds(), [3]);

  app.reviewCard(3, "bad");
  assert.deepEqual(app.queueIds(), [5, 6, 7, 8]);
}

async function testGoodReordersByNewDueAt() {
  const app = await createApp(3, 1_000_000);
  const progress = app.api.state.progress.cards;
  progress["1"] = { ...progress["1"], phase: "review", dueAt: 1_000_000 - 60_000, reviewStage: 0 };
  progress["2"] = { ...progress["2"], phase: "review", dueAt: 1_000_000 + 20 * 60_000, reviewStage: 1 };
  progress["3"] = { ...progress["3"], phase: "review", dueAt: 1_000_000 + 120 * 60_000, reviewStage: 1 };

  app.switchMode("review");
  assert.deepEqual(app.queueIds(), [1, 2, 3]);

  app.reviewCard(1, "good");
  assert.deepEqual(app.queueIds(), [2, 3, 1]);
}

const tests = [
  testNewCardsEnterReviewGroups,
  testReviewGoodAndBadTransitions,
  testReviewQueueSortsByDueTime,
  testAllModeDueNewReviewFallbacks,
  testAllModeShowsOnlyDueReviewCardsWhenAnyAreDue,
  testUserTwelveCardScenario,
  testUserCrossSessionScenario,
  testGoodReordersByNewDueAt,
];

for (const test of tests) {
  await test();
  console.log(`ok - ${test.name}`);
}
