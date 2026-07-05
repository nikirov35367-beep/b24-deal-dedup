/**
 * Bitrix24: поиск дубликатов сделки при создании (по телефону/email контакта)
 *
 * Как это работает:
 * 1. В портале Битрикс24 создаётся ВХОДЯЩИЙ вебхук (Settings -> Developer resources -> Inbound webhook)
 *    с правами: crm (сделки, контакты).
 * 2. В портале создаётся ИСХОДЯЩИЙ вебхук (Outbound webhook) на событие ONCRMDEALADD,
 *    указывающий на URL этого сервиса: https://<ваш-домен>/webhook/deal-add
 * 3. При создании новой сделки Битрикс24 присылает сюда deal_id.
 * 4. Сервис забирает сделку, находит связанный контакт, ищет по телефону/email
 *    другие сделки с тем же контактом, и если находит — добавляет комментарий
 *    (timeline comment) в новую сделку со списком дублей.
 */

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Входящий вебхук Битрикс24, например:
// https://yourportal.bitrix24.ru/rest/1/xxxxxxxxxxxxxxxx/
const B24_WEBHOOK_URL = process.env.B24_WEBHOOK_URL;

// Секрет для проверки исходящего вебхука Битрикс24 (application_token из настроек вебхука)
const B24_APP_TOKEN = process.env.B24_APP_TOKEN || '';

if (!B24_WEBHOOK_URL) {
  console.error('ОШИБКА: не задана переменная окружения B24_WEBHOOK_URL');
  process.exit(1);
}

function b24(method) {
  return `${B24_WEBHOOK_URL.replace(/\/$/, '')}/${method}`;
}

async function callB24(method, params = {}) {
  const { data } = await axios.post(b24(method), params, {
    timeout: 15000,
  });
  if (data.error) {
    throw new Error(`B24 API error [${method}]: ${data.error_description || data.error}`);
  }
  return data.result;
}

/** Получить сделку по id */
async function getDeal(dealId) {
  return callB24('crm.deal.get', { id: dealId });
}

/** Получить контакт по id */
async function getContact(contactId) {
  return callB24('crm.contact.get', { id: contactId });
}

/** Извлечь номера телефонов и email из контакта (нормализованные) */
function extractContactKeys(contact) {
  const phones = (contact.PHONE || [])
    .map((p) => normalizePhone(p.VALUE))
    .filter(Boolean);
  const emails = (contact.EMAIL || [])
    .map((e) => (e.VALUE || '').trim().toLowerCase())
    .filter(Boolean);
  return { phones, emails };
}

function normalizePhone(raw) {
  if (!raw) return null;
  // оставляем только цифры, отбрасываем ведущие + и лишние символы
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  // приводим российские номера 8XXXXXXXXXX -> 7XXXXXXXXXX для единообразия
  if (digits.length === 11 && digits.startsWith('8')) {
    return '7' + digits.slice(1);
  }
  return digits;
}

/**
 * Найти сделки-дубликаты: ищем все сделки, у которых контакт (CONTACT_ID)
 * совпадает с телефоном/email текущего контакта, исключая саму сделку.
 *
 * Стратегия:
 * 1. Найти все контакты, у которых есть совпадающий телефон или email (crm.contact.list с фильтром).
 * 2. Для каждого такого контакта получить список его сделок (crm.deal.list по CONTACT_ID).
 * 3. Исключить текущую сделку и вернуть остальные.
 */
async function findDuplicateDeals(currentDealId, contact) {
  const { phones, emails } = extractContactKeys(contact);
  if (phones.length === 0 && emails.length === 0) {
    return { duplicates: [], matchedBy: null };
  }

  const matchedContactIds = new Set();

  // Поиск контактов по телефону
  for (const phone of phones) {
    const contacts = await callB24('crm.contact.list', {
      filter: { PHONE: phone },
      select: ['ID'],
    });
    contacts.forEach((c) => matchedContactIds.add(c.ID));
  }

  // Поиск контактов по email
  for (const email of emails) {
    const contacts = await callB24('crm.contact.list', {
      filter: { EMAIL: email },
      select: ['ID'],
    });
    contacts.forEach((c) => matchedContactIds.add(c.ID));
  }

  if (matchedContactIds.size === 0) {
    return { duplicates: [], matchedBy: null };
  }

  // Для каждого совпавшего контакта получаем его сделки
  const allDeals = [];
  for (const contactId of matchedContactIds) {
    const deals = await callB24('crm.deal.list', {
      filter: { CONTACT_ID: contactId },
      select: ['ID', 'TITLE', 'STAGE_ID', 'OPPORTUNITY', 'DATE_CREATE', 'ASSIGNED_BY_ID'],
    });
    allDeals.push(...deals);
  }

  // Убираем дубли и текущую сделку
  const seen = new Set();
  const duplicates = [];
  for (const deal of allDeals) {
    if (String(deal.ID) === String(currentDealId)) continue;
    if (seen.has(deal.ID)) continue;
    seen.add(deal.ID);
    duplicates.push(deal);
  }

  return { duplicates, matchedBy: { phones, emails } };
}

/** Добавить комментарий в таймлайн сделки */
async function addTimelineComment(dealId, text) {
  return callB24('crm.timeline.comment.add', {
    fields: {
      ENTITY_ID: dealId,
      ENTITY_TYPE: 'deal',
      COMMENT: text,
    },
  });
}

function buildDuplicateMessage(duplicates) {
  const lines = [
    `⚠️ Обнаружены возможные дубликаты сделки (${duplicates.length}):`,
  ];
  duplicates.slice(0, 10).forEach((d) => {
    lines.push(
      `— Сделка #${d.ID} "${d.TITLE}" (стадия: ${d.STAGE_ID}, создана: ${d.DATE_CREATE})`
    );
  });
  if (duplicates.length > 10) {
    lines.push(`... и ещё ${duplicates.length - 10}`);
  }
  return lines.join('\n');
}

/** Проверка application_token исходящего вебхука Битрикс24, если задан */
function checkAppToken(req) {
  if (!B24_APP_TOKEN) return true; // проверка отключена, если токен не настроен
  const token = req.body.auth?.application_token || req.body.application_token;
  return token === B24_APP_TOKEN;
}

app.post('/webhook/deal-add', async (req, res) => {
  try {
    if (!checkAppToken(req)) {
      console.warn('Неверный application_token, запрос отклонён');
      return res.status(403).send('forbidden');
    }

    // Битрикс24 присылает событие в формате: data[FIELDS][ID]
    const dealId =
      req.body?.data?.FIELDS?.ID ||
      req.body?.data?.FIELDS?.ID?.[0] ||
      req.query.ID;

    if (!dealId) {
      console.warn('Не найден ID сделки в запросе', req.body);
      return res.status(400).send('no deal id');
    }

    // Отвечаем Битрикс24 сразу, обработку делаем асинхронно,
    // чтобы не блокировать вебхук (Б24 ждёт быстрый ответ).
    res.status(200).send('ok');

    processDeal(dealId).catch((err) => {
      console.error('Ошибка обработки сделки', dealId, err.message);
    });
  } catch (err) {
    console.error('Ошибка в обработчике webhook', err);
    if (!res.headersSent) res.status(500).send('error');
  }
});

async function processDeal(dealId) {
  const deal = await getDeal(dealId);
  if (!deal) {
    console.warn(`Сделка ${dealId} не найдена`);
    return;
  }

  if (!deal.CONTACT_ID) {
    console.log(`Сделка ${dealId}: нет привязанного контакта, проверка дублей пропущена`);
    return;
  }

  const contact = await getContact(deal.CONTACT_ID);
  const { duplicates, matchedBy } = await findDuplicateDeals(dealId, contact);

  if (duplicates.length === 0) {
    console.log(`Сделка ${dealId}: дубликатов не найдено`);
    return;
  }

  console.log(
    `Сделка ${dealId}: найдено ${duplicates.length} дубликатов (совпадение: ${JSON.stringify(matchedBy)})`
  );

  const message = buildDuplicateMessage(duplicates);
  await addTimelineComment(dealId, message);
}

// Проверка живости сервиса (для healthcheck платформы деплоя, ожидающей ответ на "/")
app.get('/', (req, res) => res.status(200).send('ok'));

// Проверка живости сервиса
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Сервис поиска дубликатов сделок запущен на порту ${PORT}`);
});
