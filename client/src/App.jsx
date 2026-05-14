import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

const MAX_MESSAGES = 500;
const DEFAULT_BOT_USERNAME = 'nightmare_spire_mmorpg_bot';
const DEFAULT_AUTO_RULES = [
  {
    id: 'enemy_detected',
    enabled: true,
    match: 'Обнаружен противник!',
    response: 'Напасть',
    matchMode: 'contains',
    matchTarget: 'text',
    actionType: 'send_text',
    actions: [{ id: 'enemy_detected_1', type: 'send_text', value: 'Напасть' }],
  },
  {
    id: 'battle_started',
    enabled: true,
    match: 'Бой начался!',
    response: 'Атака',
    matchMode: 'contains',
    matchTarget: 'text',
    actionType: 'send_text',
    actions: [{ id: 'battle_started_1', type: 'send_text', value: 'Атака' }],
  },
];
const MATCH_TARGETS = ['text', 'button', 'text_or_button'];
const ACTION_TYPES = ['send_text', 'press_button'];

const LOGIN_STAGE_LABELS = {
  idle: 'Ожидает входа',
  logging_in: 'Проверка данных',
  waiting_code: 'Нужен код',
  logged_in: 'Авторизован',
};

function formatTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

function getAnswerText(answer) {
  if (!answer) return '';
  return answer.message || answer.alert || answer.url || '(нет текста)';
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '';
  if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000} сек.`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1).replace('.', ',')} сек.`;
  return `${ms} мс`;
}

function loadAutoRules() {
  try {
    const saved = JSON.parse(localStorage.getItem('autoRules') || 'null');
    return Array.isArray(saved) && saved.length > 0 ? normalizeAutoRules(saved) : DEFAULT_AUTO_RULES;
  } catch {
    return DEFAULT_AUTO_RULES;
  }
}

function loadAutoActionsEnabled() {
  return localStorage.getItem('autoActionsEnabled') !== 'false';
}

function createActionStep(type = 'send_text', value = '') {
  return {
    id: `step_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    type,
    value,
  };
}

function normalizeActionStep(action, index) {
  const rawType = ACTION_TYPES.includes(action.type)
    ? action.type
    : action.type === 'press_matched_button'
      ? 'press_button'
      : ACTION_TYPES.includes(action.actionType)
        ? action.actionType
        : 'send_text';
  const value = String(action.value ?? action.response ?? action.text ?? '').trim();

  if (rawType === 'send_text' && !value) return null;

  return {
    id: action.id || `step_${Date.now()}_${index}`,
    type: rawType,
    value,
  };
}

function getRuleActions(rule, actionType) {
  const sourceActions = Array.isArray(rule.actions) && rule.actions.length > 0
    ? rule.actions
    : [{
        id: `${rule.id || 'rule'}_step_1`,
        type: actionType === 'press_matched_button' ? 'press_button' : actionType,
        value: actionType === 'send_text' ? rule.response : '',
      }];

  return sourceActions
    .map((action, index) => normalizeActionStep(action, index))
    .filter(Boolean);
}

function moveItemById(items, id, direction) {
  const currentIndex = items.findIndex((item) => item.id === id);
  const nextIndex = currentIndex + direction;

  if (currentIndex === -1 || nextIndex < 0 || nextIndex >= items.length) {
    return items;
  }

  const reordered = [...items];
  [reordered[currentIndex], reordered[nextIndex]] = [reordered[nextIndex], reordered[currentIndex]];
  return reordered;
}

function normalizeAutoRules(rules) {
  return rules
    .map((rule, index) => {
      const actionType = ACTION_TYPES.includes(rule.actionType) || rule.actionType === 'press_matched_button'
        ? rule.actionType
        : 'send_text';
      const actions = getRuleActions(rule, actionType);
      const firstAction = actions[0] || null;

      return {
        id: rule.id || `rule_${Date.now()}_${index}`,
        enabled: rule.enabled !== false,
        match: String(rule.match || '').trim(),
        response: firstAction?.type === 'send_text' ? firstAction.value : String(rule.response || '').trim(),
        matchMode: rule.matchMode || 'contains',
        matchTarget: MATCH_TARGETS.includes(rule.matchTarget) ? rule.matchTarget : 'text',
        actionType: firstAction?.type || (actionType === 'press_matched_button' ? 'press_button' : actionType),
        actions,
      };
    })
    .filter((rule) => rule.match && rule.actions.length > 0);
}

function upsertMessages(currentMessages, incomingMessages) {
  const existing = new Map(currentMessages.map((msg) => [`${msg.chatId}:${msg.msgId}`, msg]));

  for (const msg of incomingMessages) {
    const key = `${msg.chatId}:${msg.msgId}`;
    const previous = existing.get(key);

    existing.set(key, {
      ...previous,
      ...msg,
      receivedAt: msg.receivedAt || msg.messageDate || previous?.receivedAt || new Date().toISOString(),
    });
  }

  return [...existing.values()]
    .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime())
    .slice(0, MAX_MESSAGES);
}

export default function App() {
  const [connected, setConnected] = useState(false);
  const [loginStage, setLoginStage] = useState('idle');
  const [phone, setPhone] = useState(localStorage.getItem('phone') || '');
  const [targetBot, setTargetBot] = useState(localStorage.getItem('targetBot') || DEFAULT_BOT_USERNAME);
  const [code, setCode] = useState('');
  const [messages, setMessages] = useState([]);
  const [selectedAction, setSelectedAction] = useState(null);
  const [editData, setEditData] = useState('');
  const [answer, setAnswer] = useState(null);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [scanInfo, setScanInfo] = useState(null);
  const [autoRules, setAutoRules] = useState(loadAutoRules);
  const [autoActionsEnabled, setAutoActionsEnabled] = useState(loadAutoActionsEnabled);
  const [autoTiming, setAutoTiming] = useState({
    actionDelayMs: 1000,
    debounceMs: 500,
  });
  const [autoActionLog, setAutoActionLog] = useState([]);
  const [draftRule, setDraftRule] = useState({
    match: '',
    matchMode: 'contains',
    matchTarget: 'text',
    actions: [createActionStep()],
  });

  const wsRef = useRef(null);
  const phoneRef = useRef(phone);
  const targetBotRef = useRef(targetBot);
  const autoRulesRef = useRef(autoRules);
  const autoActionsEnabledRef = useRef(autoActionsEnabled);
  const autoConfigHydratedRef = useRef(false);

  useEffect(() => {
    phoneRef.current = phone;
  }, [phone]);

  useEffect(() => {
    targetBotRef.current = targetBot;
    localStorage.setItem('targetBot', targetBot);
  }, [targetBot]);

  useEffect(() => {
    autoRulesRef.current = autoRules;
    localStorage.setItem('autoRules', JSON.stringify(autoRules));
  }, [autoRules]);

  useEffect(() => {
    autoActionsEnabledRef.current = autoActionsEnabled;
    localStorage.setItem('autoActionsEnabled', String(autoActionsEnabled));
  }, [autoActionsEnabled]);

  useEffect(() => {
    const socket = new WebSocket(`ws://${window.location.hostname}:3010`);
    wsRef.current = socket;

    socket.onopen = () => {
      setConnected(true);
      setError(null);

      const savedPhone = phoneRef.current;

      if (savedPhone) {
        socket.send(JSON.stringify({
          action: 'login',
          params: {
            phone: savedPhone,
            targetBot: targetBotRef.current,
          },
        }));
        setLoginStage('logging_in');
      }
    };

    socket.onmessage = (event) => {
      let message;

      try {
        message = JSON.parse(event.data);
      } catch {
        setError('Сервер прислал ответ в неизвестном формате.');
        return;
      }

      const { type, payload } = message;

      switch (type) {
        case 'connected':
          break;
        case 'request_code':
          setLoginStage('waiting_code');
          setError(null);
          break;
        case 'login_success': {
          setLoginStage('logged_in');
          setError(null);
          localStorage.removeItem('apiId');
          localStorage.removeItem('apiHash');
          localStorage.setItem('phone', phoneRef.current);
          break;
        }
        case 'new_buttons':
          setMessages((prev) => upsertMessages(prev, [{
            ...payload,
            receivedAt: new Date().toISOString(),
          }]));
          break;
        case 'snapshot_status':
          if (payload.status === 'started') {
            setIsRefreshing(true);
          }
          break;
        case 'buttons_snapshot':
          setMessages((prev) => upsertMessages(prev, payload.messages || []));
          setScanInfo(payload);
          setIsRefreshing(false);
          if (payload.errors?.length) {
            setError(payload.errors[0]);
          }
          break;
        case 'auto_rules':
          if (!autoConfigHydratedRef.current && payload.persisted === false) {
            autoConfigHydratedRef.current = true;
            socket.send(JSON.stringify({
              action: 'set_auto_rules',
              params: {
                rules: normalizeAutoRules(autoRulesRef.current),
                targetBot: targetBotRef.current,
                enabled: autoActionsEnabledRef.current,
              },
            }));
            break;
          }

          autoConfigHydratedRef.current = true;
          if (Array.isArray(payload.rules)) {
            setAutoRules(normalizeAutoRules(payload.rules));
          }
          if (typeof payload.enabled === 'boolean') {
            setAutoActionsEnabled(payload.enabled);
          }
          if (payload.timing) {
            setAutoTiming((prev) => ({
              actionDelayMs: Number(payload.timing.actionDelayMs) || prev.actionDelayMs,
              debounceMs: Number(payload.timing.debounceMs) || prev.debounceMs,
            }));
          }
          if (payload.targetBot) {
            setTargetBot(payload.targetBot);
          }
          break;
        case 'auto_action':
          setAutoActionLog((prev) => [payload, ...prev].slice(0, 8));
          break;
        case 'callback_answer':
          setAnswer(payload);
          setIsSending(false);
          break;
        case 'error':
          setError(payload);
          setIsSending(false);
          setIsRefreshing(false);
          break;
        default:
          break;
      }
    };

    socket.onclose = () => {
      setConnected(false);
      setIsSending(false);
    };

    socket.onerror = () => {
      setError('Не удалось подключиться к WebSocket серверу.');
    };

    return () => {
      socket.close();
    };
  }, []);

  const filteredMessages = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return messages;

    return messages.filter((msg) => {
      const buttonText = (msg.buttons || [])
        .map((button) => `${button.text} ${button.data}`)
        .join(' ')
        .toLowerCase();

      return [
        msg.chatId,
        msg.msgId,
        msg.senderBot,
        msg.text,
        buttonText,
      ].join(' ').toLowerCase().includes(query);
    });
  }, [messages, search]);

  const selectedButton = selectedAction?.button || null;
  const selectedActionType = selectedButton?.action || null;
  const isCallbackButton = selectedActionType === 'callback';
  const isReplyButton = selectedActionType === 'send_message';
  const answerText = getAnswerText(answer);
  const canLogin = connected && phone.trim();
  const canSendCode = connected && code.trim();
  const connectionLabel = connected ? 'Сервер онлайн' : 'Сервер недоступен';
  const draftActions = getRuleActions(draftRule, 'send_text');
  const canAddAutoRule = draftRule.match.trim() && draftActions.length > 0;
  const actionDelayLabel = formatDuration(autoTiming.actionDelayMs);
  const debounceDelayLabel = formatDuration(autoTiming.debounceMs);

  const sendSocketAction = (action, params) => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError('Нет подключения к серверу. Проверьте, что backend запущен на порту 3010.');
      return false;
    }

    socket.send(JSON.stringify({ action, params }));
    return true;
  };

  const syncAutoConfig = (rules = autoRules, enabled = autoActionsEnabled) => {
    return sendSocketAction('set_auto_rules', {
      rules: normalizeAutoRules(rules),
      targetBot: targetBot.trim(),
      enabled,
    });
  };

  const saveAutoRules = () => {
    const normalized = normalizeAutoRules(autoRules);
    setAutoRules(normalized);
    syncAutoConfig(normalized);
  };

  const syncAutoTarget = () => {
    syncAutoConfig();
  };

  const toggleAutoActions = (event) => {
    const enabled = event.target.checked;
    setAutoActionsEnabled(enabled);
    syncAutoConfig(autoRules, enabled);
  };

  const updateAutoRule = (id, patch) => {
    setAutoRules((prev) => prev.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));
  };

  const updateDraftAction = (stepId, patch) => {
    setDraftRule((prev) => ({
      ...prev,
      actions: prev.actions.map((action) => (action.id === stepId ? { ...action, ...patch } : action)),
    }));
  };

  const addDraftAction = () => {
    setDraftRule((prev) => ({
      ...prev,
      actions: [...prev.actions, createActionStep()],
    }));
  };

  const removeDraftAction = (stepId) => {
    setDraftRule((prev) => ({
      ...prev,
      actions: prev.actions.length > 1
        ? prev.actions.filter((action) => action.id !== stepId)
        : prev.actions,
    }));
  };

  const moveDraftAction = (stepId, direction) => {
    setDraftRule((prev) => ({
      ...prev,
      actions: moveItemById(prev.actions, stepId, direction),
    }));
  };

  const updateRuleAction = (ruleId, stepId, patch) => {
    setAutoRules((prev) => prev.map((rule) => {
      if (rule.id !== ruleId) return rule;
      return {
        ...rule,
        actions: (rule.actions || []).map((action) => (
          action.id === stepId ? { ...action, ...patch } : action
        )),
      };
    }));
  };

  const addRuleAction = (ruleId) => {
    setAutoRules((prev) => prev.map((rule) => (
      rule.id === ruleId
        ? { ...rule, actions: [...(rule.actions || []), createActionStep()] }
        : rule
    )));
  };

  const removeRuleAction = (ruleId, stepId) => {
    setAutoRules((prev) => prev.map((rule) => {
      if (rule.id !== ruleId || (rule.actions || []).length <= 1) return rule;
      return {
        ...rule,
        actions: rule.actions.filter((action) => action.id !== stepId),
      };
    }));
  };

  const moveRuleAction = (ruleId, stepId, direction) => {
    setAutoRules((prev) => prev.map((rule) => {
      if (rule.id !== ruleId) return rule;
      return {
        ...rule,
        actions: moveItemById(rule.actions || [], stepId, direction),
      };
    }));
  };

  const moveAutoRule = (id, direction) => {
    setAutoRules((prev) => {
      const currentIndex = prev.findIndex((rule) => rule.id === id);
      const nextIndex = currentIndex + direction;

      if (currentIndex === -1 || nextIndex < 0 || nextIndex >= prev.length) {
        return prev;
      }

      const reordered = [...prev];
      [reordered[currentIndex], reordered[nextIndex]] = [reordered[nextIndex], reordered[currentIndex]];
      return reordered;
    });
  };

  const addAutoRule = () => {
    setAutoRules((prev) => [
      ...prev,
      {
        id: `rule_${Date.now()}`,
        enabled: true,
        match: draftRule.match.trim(),
        matchMode: draftRule.matchMode,
        matchTarget: draftRule.matchTarget,
        actionType: draftActions[0]?.type || 'send_text',
        response: draftActions[0]?.type === 'send_text' ? draftActions[0].value : '',
        actions: draftActions,
      },
    ]);
    setDraftRule({
      match: '',
      matchMode: 'contains',
      matchTarget: 'text',
      actions: [createActionStep()],
    });
  };

  const removeAutoRule = (id) => {
    setAutoRules((prev) => prev.filter((rule) => rule.id !== id));
  };

  const handleLogin = () => {
    if (!phone.trim()) {
      setError('Введите номер телефона в международном формате.');
      return;
    }

    setAnswer(null);
    setError(null);

    if (sendSocketAction('login', {
      phone: phone.trim(),
      targetBot: targetBot.trim(),
    })) {
      setLoginStage('logging_in');
    }
  };

  const sendCode = () => {
    if (!code.trim()) return;

    if (sendSocketAction('send_code', { code: code.trim() })) {
      setCode('');
      setError(null);
    }
  };

  const pressButton = (msg, button, index) => {
    setSelectedAction({
      msg,
      button,
      index,
      originalData: button.data,
    });
    setEditData(button.data);
    setAnswer(null);
  };

  const refreshMessages = () => {
    if (sendSocketAction('refresh_messages', {
      targetBot: targetBot.trim(),
      limit: 300,
    })) {
      setIsRefreshing(true);
      setError(null);
    }
  };

  const resetEditor = () => {
    if (selectedAction) {
      setEditData(selectedAction.originalData);
    }
  };

  const sendCustomCallback = () => {
    if (!selectedAction) return;
    if (!isCallbackButton && !isReplyButton) {
      setError('Этот тип кнопки пока нельзя нажать через API.');
      return;
    }

    setIsSending(true);
    setAnswer(null);
    setError(null);

    const sent = isCallbackButton
      ? sendSocketAction('press_button', {
        chatId: selectedAction.msg.chatId,
        msgId: selectedAction.msg.msgId,
        data: editData,
      })
      : sendSocketAction('send_reply_button', {
        chatId: selectedAction.msg.chatId,
        text: editData || selectedButton.text,
      });

    if (!sent) {
      setIsSending(false);
    }
  };

  const clearMessages = () => {
    setMessages([]);
    setSelectedAction(null);
    setAnswer(null);
  };

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">TC</span>
          <div>
            <h1>Telegram Callback Explorer</h1>
            <p>Перехват inline-кнопок, редактирование callback_data и проверка ответа бота.</p>
          </div>
        </div>

        <div className="topbar-status" aria-live="polite">
          <span className={`status-dot ${connected ? 'is-online' : 'is-offline'}`} />
          <span>{connectionLabel}</span>
        </div>
      </header>

      {loginStage !== 'logged_in' ? (
        <section className="auth-layout" aria-labelledby="auth-title">
          <div className="auth-copy">
            <span className="eyebrow">Рабочая сессия</span>
            <h2 id="auth-title">Подключите Telegram API</h2>
            <p>
              API ID и API Hash уже прописаны на локальном сервере. Введите только номер
              Telegram-аккаунта, а затем код подтверждения.
            </p>

            <div className="auth-state">
              <span>Статус</span>
              <strong>{LOGIN_STAGE_LABELS[loginStage]}</strong>
            </div>
          </div>

          <form className="auth-form" onSubmit={(event) => event.preventDefault()}>
            <label>
              <span>Телефон</span>
              <input
                inputMode="tel"
                placeholder="+380..."
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
              />
            </label>

            <label>
              <span>Бот для истории</span>
              <input
                placeholder="@nightmare_spire_mmorpg_bot"
                value={targetBot}
                onChange={(event) => setTargetBot(event.target.value)}
              />
            </label>

            {loginStage === 'waiting_code' ? (
              <div className="code-row">
                <label>
                  <span>Код подтверждения</span>
                  <input
                    inputMode="numeric"
                    placeholder="12345"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                  />
                </label>
                <button className="primary-button" type="button" onClick={sendCode} disabled={!canSendCode}>
                  Отправить код
                </button>
              </div>
            ) : (
              <button className="primary-button" type="button" onClick={handleLogin} disabled={!canLogin}>
                Войти
              </button>
            )}
          </form>
        </section>
      ) : (
        <section className="workspace" aria-label="Рабочая панель">
          <aside className="sidebar">
            <div className="session-panel">
              <span className="eyebrow">Сессия</span>
              <h2>{LOGIN_STAGE_LABELS[loginStage]}</h2>
              <p>{phone || 'Телефон не указан'}</p>
            </div>

            <label className="bot-field">
              <span>Бот</span>
              <input
                placeholder="@username"
                value={targetBot}
                onChange={(event) => setTargetBot(event.target.value)}
                onBlur={syncAutoTarget}
              />
            </label>

            <div className="stat-grid">
              <div className="stat">
                <span>Сообщения</span>
                <strong>{messages.length}</strong>
              </div>
              <div className="stat">
                <span>В фильтре</span>
                <strong>{filteredMessages.length}</strong>
              </div>
            </div>

            {scanInfo && (
              <div className="scan-summary">
                <span>Скан</span>
                <p>
                  {scanInfo.target ? `@${scanInfo.target}: ` : ''}
                  {scanInfo.scannedMessages || 0} сообщений, найдено {(scanInfo.messages || []).length}
                </p>
                {scanInfo.timedOut && <small>Остановлено по таймауту</small>}
              </div>
            )}

            <div className="side-actions">
              <button type="button" onClick={refreshMessages} disabled={isRefreshing}>
                {isRefreshing ? 'Обновляю...' : 'Обновить сообщения'}
              </button>
              <button type="button" onClick={clearMessages} disabled={messages.length === 0}>
                Очистить ленту
              </button>
              <button type="button" onClick={() => setSelectedAction(null)} disabled={!selectedAction}>
                Закрыть редактор
              </button>
            </div>

          </aside>

          <section className="message-pane" aria-labelledby="messages-title">
            <div className="pane-header">
              <div>
                <span className="eyebrow">Лента</span>
                <h2 id="messages-title">Сообщения с кнопками</h2>
              </div>
              <label className="search-field">
                <span>Поиск</span>
                <input
                  placeholder="Чат, кнопка, callback..."
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
            </div>

            {filteredMessages.length === 0 ? (
              <div className="empty-state">
                <strong>{messages.length === 0 ? 'Ожидаю сообщения от ботов' : 'Ничего не найдено'}</strong>
                <p>
                  {messages.length === 0
                    ? 'Как только придет сообщение с inline-кнопками, оно появится в этой ленте.'
                    : 'Попробуйте изменить запрос или очистить поле поиска.'}
                </p>
              </div>
            ) : (
              <ul className="message-list">
                {filteredMessages.map((msg, messageIndex) => (
                  <li className="message-item" key={`${msg.chatId}-${msg.msgId}-${messageIndex}`}>
                    <div className="message-meta">
                      <span>Чат {msg.chatId}</span>
                      <span>Сообщение {msg.msgId}</span>
                      <span>
                        {msg.source === 'target_history'
                          ? 'История бота'
                          : msg.source === 'history'
                            ? 'История'
                            : msg.source === 'edited'
                              ? 'Изменено'
                              : msg.source === 'after_callback'
                                ? 'После callback'
                                : 'Новое'}
                      </span>
                      <span>{formatTime(msg.receivedAt)}</span>
                    </div>
                    {msg.text && <p className="message-text">{msg.text}</p>}
                    {(msg.buttons || []).length > 0 ? (
                      <div className="button-list">
                        {msg.buttons.map((button, index) => (
                        <button
                          className={`callback-button ${button.action === 'send_message' ? 'reply-keyboard-button' : ''} ${button.action === 'unsupported' ? 'unsupported-button' : ''}`}
                          type="button"
                          key={`${button.text}-${index}`}
                          onClick={() => pressButton(msg, button, index)}
                        >
                          <span>{button.text || 'Без текста'}</span>
                          <small>
                            {button.inherited
                              ? `активная нижняя клавиатура из сообщения ${button.sourceMsgId || ''}`
                              : button.action === 'callback'
                              ? `callback_data: ${button.data || 'empty data'}`
                              : button.action === 'send_message'
                                ? 'reply keyboard: отправит текст кнопки'
                                : `${button.className || 'unsupported'}: просмотр без нажатия`}
                          </small>
                        </button>
                        ))}
                      </div>
                    ) : (
                      <p className="no-buttons">У этого сообщения нет собственных кнопок и активная нижняя клавиатура не найдена.</p>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <div className="rules-panel rules-panel-wide">
              <div className="rules-header">
                <div className="rules-title">
                  <span>Автодействия</span>
                  <small>
                    Первое правило сверху. Последнее сообщение: {debounceDelayLabel}, пауза действий: {actionDelayLabel}.
                  </small>
                </div>
                <div className="rules-header-actions">
                  <label className={`global-toggle ${autoActionsEnabled ? 'is-on' : 'is-off'}`}>
                    <input
                      type="checkbox"
                      checked={autoActionsEnabled}
                      onChange={toggleAutoActions}
                    />
                    <span>{autoActionsEnabled ? 'Авто вкл' : 'Авто выкл'}</span>
                  </label>
                  <button className="primary-button" type="button" onClick={saveAutoRules}>
                    Сохранить правила
                  </button>
                </div>
              </div>

              <div className="rule-create rule-create-wide">
                <div className="rule-section-title">
                  <span>Новое правило</span>
                  <button type="button" onClick={addAutoRule} disabled={!canAddAutoRule}>
                    Добавить правило
                  </button>
                </div>

                <div className="rule-condition-grid">
                  <input
                    value={draftRule.match}
                    placeholder={
                      draftRule.matchTarget === 'button'
                        ? 'Если есть кнопка с текстом...'
                        : draftRule.matchTarget === 'text_or_button'
                          ? 'Если текст или кнопка содержит...'
                          : 'Если сообщение содержит...'
                    }
                    onChange={(event) => setDraftRule((prev) => ({ ...prev, match: event.target.value }))}
                  />
                  <select
                    value={draftRule.matchTarget}
                    onChange={(event) => setDraftRule((prev) => ({ ...prev, matchTarget: event.target.value }))}
                  >
                    <option value="text">Текст</option>
                    <option value="button">Кнопка</option>
                    <option value="text_or_button">Текст/кнопка</option>
                  </select>
                  <select
                    value={draftRule.matchMode}
                    onChange={(event) => setDraftRule((prev) => ({ ...prev, matchMode: event.target.value }))}
                  >
                    <option value="contains">Содержит</option>
                    <option value="exact">Точно равно</option>
                    <option value="regex">Regex</option>
                  </select>
                </div>

                <div className="sequence-editor">
                  {draftRule.actions.map((action, index) => (
                    <div className="sequence-row" key={action.id}>
                      <span className="step-index">{index + 1}</span>
                      <select
                        value={action.type}
                        onChange={(event) => updateDraftAction(action.id, { type: event.target.value })}
                      >
                        <option value="send_text">Отправить текст</option>
                        <option value="press_button">Нажать кнопку</option>
                      </select>
                      <input
                        value={action.value}
                        placeholder={action.type === 'send_text'
                          ? 'Текст сообщения'
                          : 'Текст кнопки, пусто = найденная кнопка'}
                        onChange={(event) => updateDraftAction(action.id, { value: event.target.value })}
                      />
                      <div className="step-actions">
                        <button
                          type="button"
                          onClick={() => moveDraftAction(action.id, -1)}
                          disabled={index === 0}
                        >
                          Выше
                        </button>
                        <button
                          type="button"
                          onClick={() => moveDraftAction(action.id, 1)}
                          disabled={index === draftRule.actions.length - 1}
                        >
                          Ниже
                        </button>
                        <button
                          type="button"
                          onClick={() => removeDraftAction(action.id)}
                          disabled={draftRule.actions.length <= 1}
                        >
                          Удалить
                        </button>
                      </div>
                    </div>
                  ))}
                  <button type="button" onClick={addDraftAction}>
                    Добавить шаг
                  </button>
                </div>
              </div>

              <div className="rules-list rules-list-wide">
                {autoRules.map((rule, ruleIndex) => (
                  <div className="auto-rule auto-rule-wide" key={rule.id}>
                    <div className="rule-topline">
                      <label className="toggle-line">
                        <input
                          type="checkbox"
                          checked={rule.enabled}
                          onChange={(event) => updateAutoRule(rule.id, { enabled: event.target.checked })}
                        />
                        <span>{rule.enabled ? 'Вкл' : 'Выкл'}</span>
                      </label>

                      <div className="rule-priority-actions">
                        <span>Приоритет {ruleIndex + 1}</span>
                        <button
                          type="button"
                          onClick={() => moveAutoRule(rule.id, -1)}
                          disabled={ruleIndex === 0}
                        >
                          Выше
                        </button>
                        <button
                          type="button"
                          onClick={() => moveAutoRule(rule.id, 1)}
                          disabled={ruleIndex === autoRules.length - 1}
                        >
                          Ниже
                        </button>
                        <button type="button" onClick={() => removeAutoRule(rule.id)}>
                          Удалить правило
                        </button>
                      </div>
                    </div>

                    <div className="rule-condition-grid">
                      <input
                        value={rule.match}
                        placeholder="Условие"
                        onChange={(event) => updateAutoRule(rule.id, { match: event.target.value })}
                      />
                      <select
                        value={rule.matchTarget || 'text'}
                        onChange={(event) => updateAutoRule(rule.id, { matchTarget: event.target.value })}
                      >
                        <option value="text">Текст</option>
                        <option value="button">Кнопка</option>
                        <option value="text_or_button">Текст/кнопка</option>
                      </select>

                      <select
                        value={rule.matchMode || 'contains'}
                        onChange={(event) => updateAutoRule(rule.id, { matchMode: event.target.value })}
                      >
                        <option value="contains">Содержит</option>
                        <option value="exact">Точно равно</option>
                        <option value="regex">Regex</option>
                      </select>
                    </div>

                    <div className="sequence-editor">
                      {(rule.actions || []).map((action, index) => (
                        <div className="sequence-row" key={action.id}>
                          <span className="step-index">{index + 1}</span>
                          <select
                            value={action.type}
                            onChange={(event) => updateRuleAction(rule.id, action.id, { type: event.target.value })}
                          >
                            <option value="send_text">Отправить текст</option>
                            <option value="press_button">Нажать кнопку</option>
                          </select>
                          <input
                            value={action.value}
                            placeholder={action.type === 'send_text'
                              ? 'Текст сообщения'
                              : 'Текст кнопки, пусто = найденная кнопка'}
                            onChange={(event) => updateRuleAction(rule.id, action.id, { value: event.target.value })}
                          />
                          <div className="step-actions">
                            <button
                              type="button"
                              onClick={() => moveRuleAction(rule.id, action.id, -1)}
                              disabled={index === 0}
                            >
                              Выше
                            </button>
                            <button
                              type="button"
                              onClick={() => moveRuleAction(rule.id, action.id, 1)}
                              disabled={index === (rule.actions || []).length - 1}
                            >
                              Ниже
                            </button>
                            <button
                              type="button"
                              onClick={() => removeRuleAction(rule.id, action.id)}
                              disabled={(rule.actions || []).length <= 1}
                            >
                              Удалить
                            </button>
                          </div>
                        </div>
                      ))}
                      <button type="button" onClick={() => addRuleAction(rule.id)}>
                        Добавить шаг
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {autoActionLog.length > 0 && (
                <div className="auto-log">
                  <span>Последние срабатывания</span>
                  {autoActionLog.map((item) => (
                    <p key={`${item.ruleId}-${item.chatId}-${item.msgId}-${item.at}`}>
                      #{item.priority || '?'} {item.match} {'->'} {item.response}
                      {item.matchedButton ? ` (${item.matchedButton.text})` : ''}
                    </p>
                  ))}
                </div>
              )}
            </div>
          </section>

          <aside className="editor-pane" aria-labelledby="editor-title">
            <div className="pane-header compact">
              <div>
                <span className="eyebrow">Кнопка</span>
                <h2 id="editor-title">Действие кнопки</h2>
              </div>
            </div>

            {selectedAction ? (
              <div className="editor-stack">
                <div className="selected-info">
                  <span>Кнопка #{selectedAction.index + 1}</span>
                  <strong>{selectedButton?.text || 'Без текста'}</strong>
                  <p>
                    {selectedButton?.inherited
                      ? 'Активная нижняя клавиатура'
                      : isCallbackButton
                      ? 'Inline callback'
                      : isReplyButton
                        ? 'Нижняя reply-клавиатура'
                        : selectedButton?.className || 'Неподдерживаемая кнопка'}
                    {' '}в чате {selectedAction.msg.chatId}, сообщение {selectedAction.msg.msgId}
                  </p>
                </div>

                <label className="data-editor">
                  <span>{isCallbackButton ? 'callback_data' : 'Текст для отправки'}</span>
                  <textarea
                    rows={7}
                    value={editData}
                    onChange={(event) => setEditData(event.target.value)}
                    spellCheck="false"
                  />
                </label>

                <div className="editor-actions">
                  <button
                    className="primary-button"
                    type="button"
                    onClick={sendCustomCallback}
                    disabled={isSending || (!isCallbackButton && !isReplyButton)}
                  >
                    {isSending
                      ? 'Отправляю...'
                      : isCallbackButton
                        ? 'Отправить callback'
                        : isReplyButton
                          ? 'Отправить текст кнопки'
                          : 'Нельзя отправить'}
                  </button>
                  <button type="button" onClick={resetEditor} disabled={editData === selectedAction.originalData}>
                    Сбросить
                  </button>
                </div>
              </div>
            ) : (
              <div className="empty-state small">
                <strong>Выберите кнопку из ленты</strong>
                <p>Здесь появятся исходные данные callback и форма для ручной подмены.</p>
              </div>
            )}

            {answer && (
              <div className={`notice ${answer.alert ? 'notice-warning' : 'notice-success'}`} role="status">
                <span>Ответ бота</span>
                <p>{answerText}</p>
              </div>
            )}

            {error && (
              <div className="notice notice-error" role="alert">
                <span>Ошибка</span>
                <p>{error}</p>
                <button type="button" onClick={() => setError(null)}>
                  Закрыть
                </button>
              </div>
            )}
          </aside>
        </section>
      )}

      {loginStage !== 'logged_in' && error && (
        <div className="floating-error" role="alert">
          <strong>Ошибка</strong>
          <p>{error}</p>
          <button type="button" onClick={() => setError(null)}>
            Закрыть
          </button>
        </div>
      )}
    </main>
  );
}
