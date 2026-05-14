const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const { EditedMessage } = require("telegram/events/EditedMessage");
const { Api } = require("telegram");
const { ConnectionTCPObfuscated } = require("telegram/network");
const WebSocket = require("ws");
const express = require("express");
const path = require("path");
const fs = require("fs");

// ---------- Конфигурация ----------
function loadTelegramEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const allowedKeys = new Set([
    "TELEGRAM_API_ID",
    "TELEGRAM_API_HASH",
    "TELEGRAM_DC_ID",
    "TELEGRAM_DC_ADDRESS",
    "TELEGRAM_DC_PORT",
  ]);

  for (const rawLine of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    if (!allowedKeys.has(key) || process.env[key]) continue;

    const value = line
      .slice(separatorIndex + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    process.env[key] = value;
  }
}

loadTelegramEnv();

const PORT = 3010; // порт веб-сервера
const SESSION_FILE = "./session.txt"; // файл для хранения сессии
const AUTO_RULES_FILE = path.join(__dirname, "auto-rules.json");
const TELEGRAM_API_ID = Number(process.env.TELEGRAM_API_ID);
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH;
const TELEGRAM_DC_ID = Number(process.env.TELEGRAM_DC_ID);
const TELEGRAM_DC_ADDRESS = process.env.TELEGRAM_DC_ADDRESS;
const TELEGRAM_DC_PORT = Number(process.env.TELEGRAM_DC_PORT);
const HISTORY_DIALOG_LIMIT = 30;
const HISTORY_MESSAGES_PER_DIALOG = 25;
const TARGET_HISTORY_LIMIT = 200;
const SNAPSHOT_TIMEOUT_MS = 15000;
const DIALOG_SCAN_TIMEOUT_MS = 2500;
const CALLBACK_REFRESH_DELAY_MS = 1100;
const AUTO_ACTION_DELAY_MS = 600;
const AUTO_ACTION_DEBOUNCE_MS = 500;
const MAX_PROCESSED_AUTO_ACTIONS = 1000;
const DEFAULT_AUTO_RULES = [
  {
    id: "enemy_detected",
    enabled: true,
    match: "Обнаружен противник!",
    response: "Напасть",
    matchMode: "contains",
    matchTarget: "text",
    actionType: "send_text",
    actions: [{ id: "enemy_detected_1", type: "send_text", value: "Напасть" }],
  },
  {
    id: "battle_started",
    enabled: true,
    match: "Бой начался!",
    response: "Атака",
    matchMode: "contains",
    matchTarget: "text",
    actionType: "send_text",
    actions: [{ id: "battle_started_1", type: "send_text", value: "Атака" }],
  },
];
const AUTO_MATCH_TARGETS = new Set(["text", "button", "text_or_button"]);
const AUTO_ACTION_TYPES = new Set(["send_text", "press_button", "press_matched_button"]);

// ---------- Express для раздачи статики (собранного React) ----------
const app = express();
app.use(express.static(path.join(__dirname, "../client/dist")));
const httpServer = app.listen(PORT, () => {
  console.log(`Сервер запущен на http://localhost:${PORT}`);
});

// ---------- WebSocket сервер ----------
const wss = new WebSocket.Server({ server: httpServer });

// ---------- Глобальные переменные ----------
let client = null;
let loginPromise = null;
let sessionString = ""; // храним строку сессии
const watchedChatIds = new Set();
const activeReplyKeyboards = new Map();
const processedAutoActions = new Set();
const pendingAutoActions = new Map();
const lastAutoMessageIds = new Map();
const runningAutoActions = new Set();
const queuedAutoActions = new Map();
const lastAutoActionAtByChat = new Map();
let autoRules = DEFAULT_AUTO_RULES.map((rule) => ({ ...rule }));
let autoActionsEnabled = true;
let autoTargetUsername = "";
const autoTargetChatIds = new Set();

// Загружаем сессию, если есть
if (fs.existsSync(SESSION_FILE)) {
  sessionString = fs.readFileSync(SESSION_FILE, "utf-8");
  console.log("Найдена сохранённая сессия.");
}

// Функция сохранения сессии
function saveSession(sessionStr) {
  fs.writeFileSync(SESSION_FILE, sessionStr, "utf-8");
  console.log("Сессия сохранена.");
}

function createTelegramSession(sourceSession) {
  const session = new StringSession(sourceSession || "");

  if (!sourceSession) {
    session.setDC(TELEGRAM_DC_ID, TELEGRAM_DC_ADDRESS, TELEGRAM_DC_PORT);
  }

  return session;
}

function isNonceHashError(err) {
  return /invalid new nonce hash/i.test(err?.message || String(err));
}

function stringifyPeerId(value) {
  if (value === undefined || value === null) return "unknown";
  return value.toString();
}

function rememberAutoTargetId(value) {
  const id = stringifyPeerId(value);
  if (id && id !== "unknown") {
    autoTargetChatIds.add(id);
  }
}

function buttonDataToString(data) {
  if (data === undefined || data === null) return "";
  return Buffer.from(data).toString("utf-8");
}

function messageDateToIso(date) {
  if (!date) return null;
  if (date instanceof Date) return date.toISOString();
  if (typeof date === "number") return new Date(date * 1000).toISOString();
  return null;
}

function normalizeBotUsername(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\/t\.me\//i, "")
    .replace(/^@/, "")
    .split(/[/?#]/)[0];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} не ответил за ${Math.round(ms / 1000)} сек.`));
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function sendToWs(ws, type, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

async function rememberAutoTargetEntityIds(entity, inputEntity) {
  rememberAutoTargetId(entity?.id);
  rememberAutoTargetId(inputEntity?.userId);
  rememberAutoTargetId(inputEntity?.chatId);
  rememberAutoTargetId(inputEntity?.channelId);

  try {
    rememberAutoTargetId(await client.getPeerId(entity));
  } catch {
    // Не все формы entity можно превратить в peer id, остальные id уже собраны выше.
  }

  try {
    rememberAutoTargetId(await client.getPeerId(inputEntity));
  } catch {
    // Не критично: GramJS иногда не умеет получить peer id из input entity без кеша.
  }
}

async function configureAutoTarget(targetBot) {
  autoTargetUsername = normalizeBotUsername(targetBot);
  autoTargetChatIds.clear();

  if (!autoTargetUsername || !client) return;

  try {
    await resolveTargetEntity(autoTargetUsername);
    console.log(
      `Автодействия ограничены ботом @${autoTargetUsername}; ids=${[...autoTargetChatIds].join(", ")}`
    );
  } catch (err) {
    console.warn(`Не удалось настроить цель автодействий @${autoTargetUsername}: ${err.message}`);
  }
}

function isAutoTargetChat(chatId) {
  return Boolean(autoTargetUsername && autoTargetChatIds.has(stringifyPeerId(chatId)));
}

function isAutoTargetMessage(message) {
  if (!autoTargetUsername || autoTargetChatIds.size === 0) return false;

  const peerId = message.peerId || {};
  const ids = [
    message.chatId,
    message.senderId,
    peerId.userId,
    peerId.chatId,
    peerId.channelId,
  ].map(stringifyPeerId);

  return ids.some((id) => autoTargetChatIds.has(id));
}

function normalizeAutoRules(rules) {
  if (!Array.isArray(rules)) return [];

  return rules
    .map((rule, index) => {
      const actionType = AUTO_ACTION_TYPES.has(rule.actionType) ? rule.actionType : "send_text";
      const actions = normalizeAutoRuleActions(rule, actionType);
      const firstAction = actions[0] || null;

      return {
        id: String(rule.id || `rule_${index}_${Date.now()}`),
        enabled: rule.enabled !== false,
        match: String(rule.match || "").trim(),
        response: firstAction?.type === "send_text" ? firstAction.value : String(rule.response || "").trim(),
        matchMode: ["contains", "exact", "regex"].includes(rule.matchMode) ? rule.matchMode : "contains",
        matchTarget: AUTO_MATCH_TARGETS.has(rule.matchTarget) ? rule.matchTarget : "text",
        actionType: firstAction?.type || actionType,
        actions,
      };
    })
    .filter((rule) => rule.match && rule.actions.length > 0);
}

function normalizeAutoRuleActions(rule, actionType) {
  const sourceActions = Array.isArray(rule.actions) && rule.actions.length > 0
    ? rule.actions
    : [{
        id: `${rule.id || "rule"}_step_1`,
        type: actionType,
        value: actionType === "send_text" ? rule.response : "",
      }];

  return sourceActions
    .map((action, index) => {
      const rawType = AUTO_ACTION_TYPES.has(action.type)
        ? action.type
        : AUTO_ACTION_TYPES.has(action.actionType)
          ? action.actionType
          : "send_text";
      const type = rawType === "press_matched_button" ? "press_button" : rawType;
      const value = String(action.value ?? action.response ?? action.text ?? "").trim();

      if (type === "send_text" && !value) return null;

      return {
        id: String(action.id || `step_${index}_${Date.now()}`),
        type,
        value,
      };
    })
    .filter(Boolean);
}

function getAutoRulesPayload() {
  return {
    version: 1,
    enabled: autoActionsEnabled,
    targetBot: autoTargetUsername,
    rules: autoRules,
    timing: {
      actionDelayMs: AUTO_ACTION_DELAY_MS,
      debounceMs: AUTO_ACTION_DEBOUNCE_MS,
    },
    persisted: fs.existsSync(AUTO_RULES_FILE),
  };
}

function saveAutoRulesToFile() {
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    enabled: autoActionsEnabled,
    targetBot: autoTargetUsername,
    rules: autoRules,
  };
  const tmpPath = `${AUTO_RULES_FILE}.tmp`;

  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf-8");
  fs.renameSync(tmpPath, AUTO_RULES_FILE);
}

function loadAutoRulesFromFile() {
  if (!fs.existsSync(AUTO_RULES_FILE)) return;

  try {
    const saved = JSON.parse(fs.readFileSync(AUTO_RULES_FILE, "utf-8"));
    const savedRules = normalizeAutoRules(saved.rules);

    if (savedRules.length > 0) {
      autoRules = savedRules;
    }

    if (typeof saved.enabled === "boolean") {
      autoActionsEnabled = saved.enabled;
    }

    autoTargetUsername = normalizeBotUsername(saved.targetBot);
    console.log(`Автодействия загружены из ${AUTO_RULES_FILE}`);
  } catch (err) {
    console.warn(`Не удалось прочитать ${AUTO_RULES_FILE}: ${err.message}`);
  }
}

loadAutoRulesFromFile();

function rememberProcessedAutoAction(key) {
  processedAutoActions.add(key);

  if (processedAutoActions.size <= MAX_PROCESSED_AUTO_ACTIONS) return;

  const firstKey = processedAutoActions.values().next().value;
  processedAutoActions.delete(firstKey);
}

function clearPendingAutoActions() {
  for (const pending of pendingAutoActions.values()) {
    clearTimeout(pending.timer);
  }

  pendingAutoActions.clear();
  queuedAutoActions.clear();
}

async function waitForAutoActionSpacing(chatId) {
  const lastActionAt = lastAutoActionAtByChat.get(chatId) || 0;
  const remainingMs = AUTO_ACTION_DELAY_MS - (Date.now() - lastActionAt);

  if (remainingMs > 0) {
    await sleep(remainingMs);
  }
}

function rememberAutoActionSpacing(chatId) {
  lastAutoActionAtByChat.set(chatId, Date.now());
}

function ruleMatchesText(rule, text) {
  if (!text) return false;

  if (rule.matchMode === "exact") {
    return text.trim().toLowerCase() === rule.match.toLowerCase();
  }

  if (rule.matchMode === "regex") {
    try {
      return new RegExp(rule.match, "i").test(text);
    } catch {
      return false;
    }
  }

  return text.toLowerCase().includes(rule.match.toLowerCase());
}

function getAutoRuleButtons(message, chatId) {
  const ownButtons = extractMessageButtons(message);
  return ownButtons.length > 0 ? ownButtons : cloneActiveReplyButtons(chatId);
}

function getAutoRuleMatch(rule, text, buttons) {
  const matchTarget = rule.matchTarget || "text";
  const checksText = matchTarget === "text" || matchTarget === "text_or_button";
  const checksButton = matchTarget === "button" || matchTarget === "text_or_button";
  const matchedButton = checksButton
    ? buttons.find((button) => ruleMatchesText(rule, button.text))
    : null;

  if (checksText && ruleMatchesText(rule, text)) {
    return { kind: "text", button: null };
  }

  return matchedButton ? { kind: "button", button: matchedButton } : null;
}

// ---------- Вспомогательная: извлечение кнопок ----------
function getButtonClassName(button) {
  return button?.className || button?.constructor?.name || "KeyboardButton";
}

function getMarkupKind(markup) {
  if (markup instanceof Api.ReplyInlineMarkup || markup?.className === "ReplyInlineMarkup") {
    return "inline";
  }

  if (markup instanceof Api.ReplyKeyboardMarkup || markup?.className === "ReplyKeyboardMarkup") {
    return "reply_keyboard";
  }

  return "unknown";
}

function isReplyKeyboardHide(markup) {
  return markup instanceof Api.ReplyKeyboardHide || markup?.className === "ReplyKeyboardHide";
}

function normalizeButton(button, markupKind, rowIndex, columnIndex) {
  const className = getButtonClassName(button);
  const text = button.text || "Без текста";

  if (button instanceof Api.KeyboardButtonCallback || button.data !== undefined) {
    return {
      text,
      data: buttonDataToString(button.data),
      kind: "callback",
      action: "callback",
      markupKind,
      className,
      rowIndex,
      columnIndex,
    };
  }

  if (button instanceof Api.KeyboardButton || className === "KeyboardButton") {
    return {
      text,
      data: text,
      kind: "reply",
      action: "send_message",
      markupKind,
      className,
      rowIndex,
      columnIndex,
    };
  }

  if (button.url) {
    return {
      text,
      data: button.url,
      kind: "url",
      action: "unsupported",
      markupKind,
      className,
      rowIndex,
      columnIndex,
    };
  }

  return {
    text,
    data: text,
    kind: "unsupported",
    action: "unsupported",
    markupKind,
    className,
    rowIndex,
    columnIndex,
  };
}

function extractMessageButtons(message) {
  const markup = message.replyMarkup;
  if (!markup || !Array.isArray(markup.rows)) return [];
  const markupKind = getMarkupKind(markup);
  const buttons = [];
  for (const [rowIndex, row] of markup.rows.entries()) {
    for (const [columnIndex, btn] of (row.buttons || []).entries()) {
      buttons.push(normalizeButton(btn, markupKind, rowIndex, columnIndex));
    }
  }
  return buttons;
}

function getReplyKeyboardButtons(buttons) {
  return buttons.filter((button) => button.markupKind === "reply_keyboard");
}

function rememberReplyKeyboard(chatId, message, buttons) {
  const replyButtons = getReplyKeyboardButtons(buttons);
  if (replyButtons.length === 0) return;

  activeReplyKeyboards.set(chatId, {
    buttons: replyButtons,
    sourceMsgId: message.id,
    sourceDate: messageDateToIso(message.date),
  });
}

function clearReplyKeyboard(chatId, message) {
  if (isReplyKeyboardHide(message.replyMarkup)) {
    activeReplyKeyboards.delete(chatId);
  }
}

function cloneActiveReplyButtons(chatId) {
  const keyboard = activeReplyKeyboards.get(chatId);
  if (!keyboard?.buttons?.length) return [];

  return keyboard.buttons.map((button) => ({
    ...button,
    inherited: true,
    sourceMsgId: keyboard.sourceMsgId,
    sourceDate: keyboard.sourceDate,
  }));
}

function messageToPayload(message, source = "live", includeWithoutButtons = false, inheritedButtons = null) {
  const chatId = stringifyPeerId(message.chatId || message.peerId);
  const ownButtons = extractMessageButtons(message);
  const fallbackButtons = inheritedButtons || (ownButtons.length === 0 ? cloneActiveReplyButtons(chatId) : []);
  const buttons = ownButtons.length > 0 ? ownButtons : fallbackButtons;
  if (buttons.length === 0 && !includeWithoutButtons) return null;

  return {
    chatId,
    msgId: message.id,
    buttons,
    keyboardSource: ownButtons.length > 0 ? "message" : buttons.length > 0 ? "active_reply_keyboard" : "none",
    senderBot: stringifyPeerId(message.senderId),
    text: message.message || "",
    source,
    messageDate: messageDateToIso(message.date),
  };
}

async function handleButtonMessage(message, source = "live") {
  const chatId = stringifyPeerId(message.chatId || message.peerId);
  const ownButtons = extractMessageButtons(message);
  clearReplyKeyboard(chatId, message);
  rememberReplyKeyboard(chatId, message, ownButtons);

  const payload = messageToPayload(message, source, watchedChatIds.has(chatId));
  if (!payload) return;

  console.log(
    `Найдены кнопки: chat=${payload.chatId}, msg=${payload.msgId}, source=${source}, buttons=${payload.buttons.length}`
  );
  broadcast("new_buttons", payload);
}

async function getMessagePeer(message, chatId) {
  if (typeof message.getInputChat === "function") {
    try {
      return await message.getInputChat();
    } catch {
      // Fallback ниже работает для сохраненных entity.
    }
  }

  return client.getInputEntity(chatId);
}

function buttonTextMatches(button, query) {
  const buttonText = String(button?.text || "").trim().toLowerCase();
  const searchText = String(query || "").trim().toLowerCase();
  return Boolean(searchText && buttonText.includes(searchText));
}

async function findLatestButtonByText(peer, query) {
  if (!query) return null;

  try {
    const result = await collectMessagesFromEntity(peer, 12, "auto_step_lookup", true);

    for (let messageIndex = result.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const payload = result.messages[messageIndex];
      const button = (payload.buttons || []).find((item) => buttonTextMatches(item, query));
      if (button) {
        return { button, msgId: payload.msgId };
      }
    }
  } catch (err) {
    console.warn(`Не удалось найти кнопку для автодействия: ${err.message}`);
  }

  return null;
}

async function resolveAutoStepButton(step, peer, match, msgId) {
  if (step.value) {
    const latestButton = await findLatestButtonByText(peer, step.value);
    if (latestButton) return latestButton;
  }

  if (match.button && (!step.value || buttonTextMatches(match.button, step.value))) {
    return { button: match.button, msgId };
  }

  return null;
}

async function executeAutoRuleStep(step, peer, chatId, msgId, match) {
  if (step.type === "send_text") {
    if (!step.value) return null;

    await waitForAutoActionSpacing(chatId);
    if (!autoActionsEnabled) return null;

    try {
      await client.sendMessage(peer, { message: step.value });
      await sleep(CALLBACK_REFRESH_DELAY_MS);
      await refreshRecentChatMessages(peer, "after_auto_action");
    } finally {
      rememberAutoActionSpacing(chatId);
    }

    return {
      type: step.type,
      response: step.value,
      button: null,
      skipped: false,
    };
  }

  if (step.type === "press_button") {
    const target = await resolveAutoStepButton(step, peer, match, msgId);
    const button = target?.button;

    if (!button || button.action === "unsupported") {
      return {
        type: step.type,
        response: step.value ? `Кнопка не найдена: ${step.value}` : "Кнопка для нажатия не найдена",
        button: null,
        skipped: true,
      };
    }

    if (button.action === "callback") {
      await waitForAutoActionSpacing(chatId);
      if (!autoActionsEnabled) return null;

      let answer;
      try {
        answer = await pressCallbackButton(chatId, target.msgId, button.data);
      } finally {
        rememberAutoActionSpacing(chatId);
      }

      return {
        type: step.type,
        response: `Нажата кнопка: ${button.text}`,
        button,
        answer,
        skipped: false,
      };
    }

    if (button.action === "send_message") {
      await waitForAutoActionSpacing(chatId);
      if (!autoActionsEnabled) return null;

      let answer;
      try {
        answer = await sendReplyKeyboardButton(chatId, button.text);
      } finally {
        rememberAutoActionSpacing(chatId);
      }

      return {
        type: step.type,
        response: answer.message,
        button,
        answer,
        skipped: false,
      };
    }
  }

  return null;
}

async function executeAutoRuleSequence(rule, peer, chatId, msgId, match) {
  const results = [];

  for (const step of rule.actions) {
    if (!autoActionsEnabled) break;

    const result = await executeAutoRuleStep(step, peer, chatId, msgId, match);
    if (!result) continue;

    results.push(result);
    if (result.skipped) break;
  }

  return results;
}

async function runAutoActionQueue(chatId, message, source) {
  if (runningAutoActions.has(chatId)) {
    queuedAutoActions.set(chatId, { message, source });
    return;
  }

  runningAutoActions.add(chatId);

  try {
    let current = { message, source };

    while (current && autoActionsEnabled) {
      try {
        await applyAutoRules(current.message, current.source);
      } catch (err) {
        console.error("Ошибка автодействий:", err);
      }

      current = queuedAutoActions.get(chatId) || null;
      queuedAutoActions.delete(chatId);
    }
  } finally {
    runningAutoActions.delete(chatId);

    if (queuedAutoActions.has(chatId) && autoActionsEnabled) {
      const queued = queuedAutoActions.get(chatId);
      queuedAutoActions.delete(chatId);
      runAutoActionQueue(chatId, queued.message, queued.source);
    }
  }
}

function scheduleAutoRules(message, source = "live") {
  if (!client || message.out || !autoActionsEnabled) return;

  const chatId = stringifyPeerId(message.chatId || message.peerId);
  if (!isAutoTargetChat(chatId) && !isAutoTargetMessage(message)) return;

  const msgId = Number(message.id || 0);
  const lastMsgId = Number(lastAutoMessageIds.get(chatId) || 0);
  if (msgId < lastMsgId) return;

  lastAutoMessageIds.set(chatId, msgId);

  const pending = pendingAutoActions.get(chatId);
  if (pending) {
    clearTimeout(pending.timer);
  }

  const timer = setTimeout(async () => {
    const current = pendingAutoActions.get(chatId);
    if (current?.timer !== timer) return;

    pendingAutoActions.delete(chatId);

    runAutoActionQueue(chatId, message, source);
  }, AUTO_ACTION_DEBOUNCE_MS);

  pendingAutoActions.set(chatId, {
    timer,
    msgId,
    source,
  });
}

async function applyAutoRules(message, source = "live") {
  if (!client || message.out || !autoActionsEnabled) return;

  const text = String(message.message || "");
  const chatId = stringifyPeerId(message.chatId || message.peerId);
  if (!isAutoTargetChat(chatId) && !isAutoTargetMessage(message)) return;

  const buttons = getAutoRuleButtons(message, chatId);
  const matchedRules = autoRules
    .map((rule, index) => ({ rule, priority: index + 1 }))
    .filter((entry) => entry.rule.enabled)
    .map((entry) => ({ ...entry, match: getAutoRuleMatch(entry.rule, text, buttons) }))
    .filter((entry) => entry.match);

  if (matchedRules.length === 0) return;

  const { rule, match, priority } = matchedRules[0];
  const key = `${chatId}:${message.id}:${rule.id}`;
  if (processedAutoActions.has(key)) return;

  const peer = await getMessagePeer(message, chatId);

  rememberProcessedAutoAction(key);

  const results = await executeAutoRuleSequence(rule, peer, chatId, message.id, match);
  if (results.length === 0) return;

  const response = results.map((result) => result.response).join(" -> ");
  const matchedButton = results.find((result) => result.button)?.button || match.button || null;

  broadcast("auto_action", {
    ruleId: rule.id,
    priority,
    match: rule.match,
    response,
    actionType: rule.actionType,
    matchTarget: rule.matchTarget,
    matchedBy: match.kind,
    actions: results.map((result) => ({
      type: result.type,
      response: result.response,
      skipped: result.skipped,
      button: result.button
        ? {
            text: result.button.text,
            action: result.button.action,
            markupKind: result.button.markupKind,
          }
        : null,
    })),
    matchedButton: matchedButton
      ? {
          text: matchedButton.text,
          action: matchedButton.action,
          markupKind: matchedButton.markupKind,
        }
      : null,
    chatId,
    msgId: message.id,
    source,
    at: new Date().toISOString(),
  });
  console.log(`Автодействие #${priority}: "${rule.match}" -> "${response}" для chat=${chatId}, msg=${message.id}`);
}

async function resolveTargetEntity(targetBot) {
  const username = normalizeBotUsername(targetBot);
  if (!username) return null;

  const entity = await client.getEntity(`@${username}`);
  const inputEntity = await client.getInputEntity(entity);
  await rememberAutoTargetEntityIds(entity, inputEntity);
  return inputEntity;
}

async function collectMessagesFromEntity(entity, limit, source, includeWithoutButtons) {
  const found = [];
  const seen = new Set();
  const messages = [];
  let scannedMessages = 0;

  for await (const message of client.iterMessages(entity, { limit })) {
    scannedMessages += 1;
    messages.push(message);
  }

  messages.sort((a, b) => {
    const leftDate = a.date instanceof Date ? a.date.getTime() : Number(a.date || 0) * 1000;
    const rightDate = b.date instanceof Date ? b.date.getTime() : Number(b.date || 0) * 1000;
    if (leftDate !== rightDate) return leftDate - rightDate;
    return Number(a.id || 0) - Number(b.id || 0);
  });

  let localActiveKeyboard = null;

  for (const message of messages) {
    const chatId = stringifyPeerId(message.chatId || message.peerId);
    const ownButtons = extractMessageButtons(message);
    let inheritedButtons = [];

    if (isReplyKeyboardHide(message.replyMarkup)) {
      localActiveKeyboard = null;
      activeReplyKeyboards.delete(chatId);
    }

    if (ownButtons.length === 0 && localActiveKeyboard?.buttons?.length) {
      inheritedButtons = localActiveKeyboard.buttons.map((button) => ({
        ...button,
        inherited: true,
        sourceMsgId: localActiveKeyboard.sourceMsgId,
        sourceDate: localActiveKeyboard.sourceDate,
      }));
    }

    const payload = messageToPayload(message, source, includeWithoutButtons, inheritedButtons);
    if (!payload) continue;

    const key = `${payload.chatId}:${payload.msgId}`;
    if (seen.has(key)) continue;

    seen.add(key);
    watchedChatIds.add(payload.chatId);
    found.push(payload);

    const replyButtons = getReplyKeyboardButtons(ownButtons);
    if (replyButtons.length > 0) {
      localActiveKeyboard = {
        buttons: replyButtons,
        sourceMsgId: message.id,
        sourceDate: messageDateToIso(message.date),
      };
      activeReplyKeyboards.set(chatId, localActiveKeyboard);
    }
  }

  return { messages: found, scannedMessages };
}

async function collectTargetMessages(targetBot, limit) {
  const username = normalizeBotUsername(targetBot);
  const entity = await resolveTargetEntity(username);

  try {
    watchedChatIds.add(stringifyPeerId(await client.getPeerId(entity)));
  } catch {
    // История ниже все равно добавит chatId из найденных сообщений.
  }

  const result = await collectMessagesFromEntity(
    entity,
    limit || TARGET_HISTORY_LIMIT,
    "target_history",
    true
  );

  return {
    messages: result.messages,
    scannedDialogs: 1,
    scannedMessages: result.scannedMessages,
    target: username,
    errors: [],
    timedOut: false,
  };
}

async function collectDialogMessages() {
  if (!client) return { messages: [], scannedDialogs: 0, scannedMessages: 0, errors: [], timedOut: false };

  const found = [];
  const seen = new Set();
  const errors = [];
  let scannedDialogs = 0;
  let scannedMessages = 0;
  let timedOut = false;
  const deadline = Date.now() + SNAPSHOT_TIMEOUT_MS;

  for await (const dialog of client.iterDialogs({ limit: HISTORY_DIALOG_LIMIT })) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 1000) {
      timedOut = true;
      break;
    }

    scannedDialogs += 1;

    try {
      const result = await withTimeout(
        collectMessagesFromEntity(dialog.inputEntity, HISTORY_MESSAGES_PER_DIALOG, "history", false),
        Math.min(DIALOG_SCAN_TIMEOUT_MS, remainingMs),
        `Диалог "${dialog.name || dialog.id}"`
      );
      scannedMessages += result.scannedMessages;

      for (const payload of result.messages) {
        const key = `${payload.chatId}:${payload.msgId}`;
        if (seen.has(key)) continue;

        seen.add(key);
        found.push(payload);
      }
    } catch (err) {
      const message = `Не удалось прочитать историю диалога "${dialog.name || dialog.id}": ${err.message}`;
      errors.push(message);
      console.warn(message);
    }
  }

  found.sort((a, b) => {
    const left = a.messageDate ? new Date(a.messageDate).getTime() : 0;
    const right = b.messageDate ? new Date(b.messageDate).getTime() : 0;
    return right - left;
  });

  return { messages: found, scannedDialogs, scannedMessages, errors, timedOut };
}

async function collectRecentMessages(params = {}) {
  if (!client) return { messages: [], scannedDialogs: 0, scannedMessages: 0, errors: [], timedOut: false };

  const targetBot = normalizeBotUsername(params.targetBot);
  const limit = Number(params.limit) || undefined;

  try {
    if (targetBot) {
      await configureAutoTarget(targetBot);
      return await withTimeout(
        collectTargetMessages(targetBot, limit),
        SNAPSHOT_TIMEOUT_MS,
        `История @${targetBot}`
      );
    }

    return await withTimeout(collectDialogMessages(), SNAPSHOT_TIMEOUT_MS, "Сканирование истории");
  } catch (err) {
    return {
      messages: [],
      scannedDialogs: 0,
      scannedMessages: 0,
      target: targetBot || null,
      errors: [err.message],
      timedOut: true,
    };
  }
}

async function sendButtonSnapshot(ws, params = {}) {
  sendToWs(ws, "snapshot_status", { status: "started" });
  const snapshot = await collectRecentMessages(params);
  sendToWs(ws, "buttons_snapshot", snapshot);
  console.log(
    `История просканирована: dialogs=${snapshot.scannedDialogs}, messages=${snapshot.scannedMessages}, withButtons=${snapshot.messages.length}`
  );
}

// ---------- Отправка данных всем подключённым клиентам ----------
function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

// ---------- Подключение Telegram ----------
async function initTelegram(apiId, apiHash, phone, phoneCodeCallback) {
  if (loginPromise) {
    return loginPromise;
  }

  loginPromise = startTelegram(apiId, apiHash, phone, phoneCodeCallback).finally(() => {
    loginPromise = null;
  });

  return loginPromise;
}

async function startTelegram(apiId, apiHash, phone, phoneCodeCallback) {
  if (client?.connected) {
    try {
      if (await client.isUserAuthorized()) {
        return true;
      }
    } catch {
      // Если проверка текущего клиента сломалась, ниже будет создан новый.
    }
  }

  if (client) {
    await client.disconnect().catch(() => {});
    client = null;
  }

  const sessionsToTry = [sessionString || "", ""];
  let lastError = null;

  for (const sourceSession of sessionsToTry) {
    const session = createTelegramSession(sourceSession);
    client = new TelegramClient(session, apiId, apiHash, {
      connection: ConnectionTCPObfuscated,
      connectionRetries: 5,
      timeout: 15,
      retryDelay: 1000,
      useWSS: true,
      deviceModel: "Desktop",
      systemVersion: process.platform,
      appVersion: "1.0",
      langCode: "ru",
      systemLangCode: "ru",
    });

    try {
      await client.start({
        phoneNumber: phone,
        phoneCode: async () => await phoneCodeCallback(),
        onError: (err) => console.error("Ошибка авторизации:", err),
      });
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      await client.disconnect().catch(() => {});
      client = null;

      if (!sourceSession || !isNonceHashError(err)) {
        break;
      }

      console.warn("Сессия или auth key не прошли проверку nonce, пробую чистую сессию.");
      sessionString = "";
    }
  }

  if (lastError) {
    throw lastError;
  }

  sessionString = client.session.save();
  saveSession(sessionString);
  console.log("Клиент Telegram авторизован");

  // Обработчики новых и отредактированных сообщений.
  const onMessageWithButtons = async (event, source) => {
    try {
      if (!event.message) return;
      await handleButtonMessage(event.message, source);
      scheduleAutoRules(event.message, source);
    } catch (err) {
      console.error("Ошибка обработки сообщения с кнопками:", err);
    }
  };

  client.addEventHandler((event) => onMessageWithButtons(event, "new"), new NewMessage({}));
  client.addEventHandler((event) => onMessageWithButtons(event, "edited"), new EditedMessage({}));
  return true;
}

// ---------- Функция нажатия кнопки (с подменой) ----------
async function pressCallbackButton(chatId, msgId, data) {
  const peer = await client.getInputEntity(chatId);
  const result = await client.invoke(
    new Api.messages.GetBotCallbackAnswer({
      peer,
      msgId: msgId,
      data: Buffer.from(data, "utf-8"),
    })
  );

  await sleep(CALLBACK_REFRESH_DELAY_MS);

  try {
    const [updatedMessage] = await client.getMessages(peer, { ids: Number(msgId) });
    if (updatedMessage) {
      const payload = messageToPayload(updatedMessage, "after_callback", true);
      if (payload) {
        watchedChatIds.add(payload.chatId);
        broadcast("new_buttons", payload);
      }
    }
  } catch (err) {
    console.warn(`Не удалось обновить сообщение после callback: ${err.message}`);
  }

  return {
    message: result.message || "",
    alert: result.alert || "",
    url: result.url || "",
  };
}

async function refreshRecentChatMessages(peer, source) {
  try {
    const result = await collectMessagesFromEntity(peer, 20, source, true);
    for (const payload of result.messages) {
      watchedChatIds.add(payload.chatId);
      broadcast("new_buttons", payload);
    }
  } catch (err) {
    console.warn(`Не удалось обновить последние сообщения чата: ${err.message}`);
  }
}

async function sendReplyKeyboardButton(chatId, text) {
  if (!text || !String(text).trim()) {
    throw new Error("У reply-кнопки нет текста для отправки.");
  }

  const peer = await client.getInputEntity(chatId);
  await client.sendMessage(peer, { message: String(text).trim() });
  await sleep(CALLBACK_REFRESH_DELAY_MS);
  await refreshRecentChatMessages(peer, "after_reply_keyboard");

  return {
    message: `Отправлено: ${String(text).trim()}`,
    alert: "",
    url: "",
  };
}

// ---------- Обработка команд через WebSocket ----------
wss.on("connection", (ws) => {
  console.log("Клиент WebSocket подключён");
  ws.send(JSON.stringify({ type: "connected", payload: null }));
  sendToWs(ws, "auto_rules", getAutoRulesPayload());

  ws.on("message", async (data) => {
    try {
      const { action, params } = JSON.parse(data.toString());
      if (action === "login") {
        // params: { phone }, apiId/apiHash берутся из локальной конфигурации сервера
        const apiId = Number(params?.apiId) || TELEGRAM_API_ID;
        const apiHash = params?.apiHash || TELEGRAM_API_HASH;
        const phone = params?.phone;

        if (!apiId || !apiHash || !phone) {
          throw new Error("Не хватает данных для авторизации: проверьте API ID, API Hash и телефон.");
        }

        // Запрашиваем код через WebSocket
        const phoneCodeCallback = () => {
          return new Promise((resolve) => {
            broadcast("request_code", { phone });
            // Слушаем ответ с кодом от этого же клиента (или от любого)
            const onCode = (codeData) => {
              let codeMessage;

              try {
                codeMessage = JSON.parse(codeData.toString());
              } catch {
                return;
              }

              const { action: act, params: p } = codeMessage;
              if (act === "send_code" && p?.code) {
                ws.removeListener("message", onCode);
                resolve(p.code.trim());
              }
            };
            ws.on("message", onCode);
          });
        };
        await initTelegram(
          apiId,
          apiHash,
          phone,
          phoneCodeCallback
        );
        await configureAutoTarget(params?.targetBot);
        ws.send(JSON.stringify({ type: "login_success", payload: null }));
        await sendButtonSnapshot(ws, params);
      } else if (action === "press_button") {
        // params: { chatId, msgId, data }
        const answer = await pressCallbackButton(
          params.chatId,
          params.msgId,
          params.data
        );
        ws.send(JSON.stringify({ type: "callback_answer", payload: answer }));
      } else if (action === "send_reply_button") {
        const answer = await sendReplyKeyboardButton(params.chatId, params.text);
        ws.send(JSON.stringify({ type: "callback_answer", payload: answer }));
      } else if (action === "set_auto_rules") {
        autoRules = normalizeAutoRules(params?.rules);
        if (typeof params?.enabled === "boolean") {
          autoActionsEnabled = params.enabled;
          if (!autoActionsEnabled) {
            clearPendingAutoActions();
          }
        }
        await configureAutoTarget(params?.targetBot);
        saveAutoRulesToFile();
        sendToWs(ws, "auto_rules", getAutoRulesPayload());
      } else if (action === "send_code") {
        // уже обрабатывается в Promise, но можем залогировать
      } else if (action === "refresh_messages") {
        if (!client) {
          throw new Error("Telegram-клиент еще не авторизован.");
        }
        await sendButtonSnapshot(ws, params);
      }
    } catch (err) {
      console.error(err);
      ws.send(JSON.stringify({ type: "error", payload: err.message }));
    }
  });
});
