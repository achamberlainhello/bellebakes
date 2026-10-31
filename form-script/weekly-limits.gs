/**
 * Belle Bakes – weekly order limits and pickup days for the Pre-Order Google Form.
 *
 * What it does
 *   - Bakes are split by day: each item has its own Thursday and Friday limit.
 *   - Adds a required "When would you like to pick up?" question (Thursday / Friday).
 *   - After every order, decides the pickup day. A whole order goes to one day:
 *     it gets the day the customer chose if everything in it still fits that day's batch;
 *     otherwise it moves to the other day, the customer gets an email, and the order
 *     Sheet's "Confirmed pickup" column says so.
 *   - Trims the quantity choices so nobody can pick more than one day's batch has left,
 *     hides a pickup day once it's fully booked, and closes the form when everything is gone.
 *   - Orders for both pickup days close Wednesday at 8pm.
 *   - Every Friday at 8pm it starts a new week: all choices come back and the form reopens.
 *
 * Setup (once): paste this file into an Apps Script project (script.google.com, or ⋮ → Apps Script in the form) and save.
 * Ideally Annabelle then runs "setup" from her own Google account (toolbar → choose setup → Run),
 * so emails to customers come from her and the script runs under her account.
 *
 * Handy functions to run by hand from the toolbar:
 *   resetWeek()   – start a new week right now
 *   checkStatus() – see this week's counts by day (shown in the Execution log)
 *   saveChoices() – after editing the quantity choices in the form (e.g. adding "5 loaves"),
 *                   run this so the script remembers the new full list
 */

// ---------- Settings ----------

// The Pre-Order Form's ID (from its edit link: docs.google.com/forms/d/<ID>/edit).
// Lets this script live as its own Apps Script project. Leave blank if the script
// was added from inside the form (⋮ → Apps Script).
const FORM_ID = '1nszT6Q0ebBJlTx-gVUr2F9am2Ho5lT0yN5F6GVj_log';

// Question titles must match the form exactly. The number in each choice
// ("2 loaves", "3 bundles (12 cookies)") is what gets counted.
const ITEMS = [
  { title: 'Sourdough?', unit: 'loaves', perDay: { Thursday: 4, Friday: 4 } },
  { title: 'How many cookies would you like?', unit: 'cookie bundles', perDay: { Thursday: 7, Friday: 8 } },
];

const PICKUP = {
  title: 'When would you like to pick up?',
  days: ['Thursday', 'Friday'],
  help: 'We bake half of each item for Thursday and half for Friday. Orders for both days close Wednesday at 8pm. ' +
        'If your whole order can’t be ready Thursday, ' +
        'we’ll move it to Friday and email you.',
};

const NAME_TITLE = 'Name (first & last)';
const EMAIL_TITLE = 'Email';
const PICKUP_COLUMN = 'Confirmed pickup';   // added to the order Sheet
const WEEK_COLUMN = 'Week';                 // e.g. "Week of Nov 5", for filtering the Sheet

const SHOP_NAME = 'Belle Bakes';
const SOLD_OUT_CHOICE = 'Sold out this week';
const CLOSED_MESSAGE = 'We’re sold out this week! Thank you so much ♡ Check back soon for next week’s bakes.';

const CLOSED_FOR_WEEK_MESSAGE = 'Orders for this week are closed. New orders open Friday at 8pm ♡';

// Weekly schedule, in the script's time zone (Project Settings → Time zone).
// Each pickup day stops taking orders at its cutoff; a new week opens Friday evening.
const SCHEDULE = {
  opens: { day: 'FRIDAY', hour: 20 },                 // Friday 8pm: next week's orders open
  cutoffs: {
    Thursday: { day: 'WEDNESDAY', hour: 20 },         // Thursday pickup closes Wednesday 8pm
    Friday: { day: 'WEDNESDAY', hour: 20 },           // Friday pickup also closes Wednesday 8pm
  },
};

// Gets a heads-up if two orders land at once and a day goes over its limit; also the reply-to
// address on customer emails. Leave blank to use the Google account that ran setup().
const ALERT_EMAIL = '';

// ---------- Setup and weekly reset ----------

function setup() {
  const form = form_();
  const props = PropertiesService.getScriptProperties();
  ensurePickupQuestion_(form);

  // Remember the full list of choices the first time, so they can come back each week.
  if (!props.getProperty('originals')) {
    const originals = {};
    for (const title of ITEMS.map(i => i.title).concat(PICKUP.title)) {
      originals[title] = choiceValues_(findItem_(form, title)).filter(v => v !== SOLD_OUT_CHOICE);
    }
    props.setProperty('originals', JSON.stringify(originals));
  }
  if (!props.getProperty('weekStart')) props.setProperty('weekStart', String(Date.now()));

  // Replace any earlier triggers from this script, then add the two it needs.
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('onOrder').forForm(form).onFormSubmit().create();
  ScriptApp.newTrigger('resetWeek').timeBased()
    .onWeekDay(ScriptApp.WeekDay[SCHEDULE.opens.day]).atHour(SCHEDULE.opens.hour).create();
  // One refresh per distinct cutoff time (both days can share Wednesday 8pm).
  const cutoffTimes = new Set(Object.values(SCHEDULE.cutoffs).map(cut => `${cut.day} ${cut.hour}`));
  for (const time of cutoffTimes) {
    const [day, hour] = time.split(' ');
    ScriptApp.newTrigger('refresh').timeBased().onWeekDay(ScriptApp.WeekDay[day]).atHour(Number(hour)).create();
  }

  Logger.log(updateForm_(form, weekState_(form).used).join('\n'));
}

function saveChoices() {
  PropertiesService.getScriptProperties().deleteProperty('originals');
  setup();
}

function resetWeek() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('weekStart', String(Date.now()));
  props.deleteProperty('assigned');
  const form = form_();
  Logger.log(updateForm_(form, weekState_(form).used).join('\n'));   // restores every choice, reopens the form
}

// Runs at each cutoff so a pickup day comes off the form on time.
function refresh() {
  const form = form_();
  Logger.log(updateForm_(form, weekState_(form).used).join('\n'));
}

function checkStatus() {
  const form = form_();
  const { used } = weekState_(form);
  for (const day of PICKUP.days) {
    for (const item of ITEMS) {
      Logger.log(`${day}  ${item.title}  ${used[day][item.title]} of ${item.perDay[day]} ${item.unit}`);
    }
  }
  for (const [day, when] of Object.entries(cutoffs_())) {
    Logger.log(`${day} pickup orders close ${when}`);
  }
  Logger.log(`Form is ${form.isAcceptingResponses() ? 'open' : 'closed'}.`);
}

// ---------- Runs after every order ----------

function onOrder() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const form = form_();
    const { used, fresh } = weekState_(form);
    for (const { response, order, day } of fresh) {
      try { recordPickup_(form, response, order, day); } catch (err) { Logger.log('Sheet: ' + err); }
      if (order.preferred && day !== order.preferred) emailMoved_(order, day);
    }
    const over = [];
    for (const day of PICKUP.days) {
      for (const item of ITEMS) {
        if (used[day][item.title] > item.perDay[day]) over.push(`• ${day} ${item.title}: ${used[day][item.title]} ordered, limit ${item.perDay[day]} ${item.unit}`);
      }
    }
    if (over.length) alertOversold_(over, fresh);
    // Orders that slipped in after Wednesday's cutoff, before the form had closed
    if (PICKUP.days.every(isClosed_)) fresh.forEach(f => alertLate_(f.order));
    updateForm_(form, used);
  } finally {
    lock.releaseLock();
  }
}

// ---------- Deciding pickup days ----------

// Walks this week's orders in the order they arrived. Orders already given a day keep it;
// new ones get a day now. Returns what's used per day, plus the newly assigned orders.
function weekState_(form) {
  const props = PropertiesService.getScriptProperties();
  const assigned = JSON.parse(props.getProperty('assigned') || '{}');
  const since = new Date(Number(props.getProperty('weekStart') || 0));
  const used = {};
  PICKUP.days.forEach(day => { used[day] = {}; ITEMS.forEach(i => { used[day][i.title] = 0; }); });

  const fresh = [];
  const responses = form.getResponses(since).sort((a, b) => a.getTimestamp() - b.getTimestamp());
  for (const response of responses) {
    const order = readOrder_(response);
    let day = assigned[response.getId()];
    if (!day) {
      day = chooseDay_(order, used);
      assigned[response.getId()] = day;
      fresh.push({ response, order, day });
    }
    ITEMS.forEach(i => { used[day][i.title] += order.qty[i.title]; });
  }
  props.setProperty('assigned', JSON.stringify(assigned));
  return { used, fresh };
}

function fits_(order, used, day) {
  return ITEMS.every(i => used[day][i.title] + order.qty[i.title] <= i.perDay[day]);
}

// The chosen day if it's still taking orders and the whole order fits; otherwise another open
// day where it fits. If nothing fits (two orders at once), it stays put and Annabelle gets an email.
function chooseDay_(order, used) {
  const openDays = PICKUP.days.filter(d => !isClosed_(d));
  const preferred = openDays.includes(order.preferred)
    ? order.preferred
    : openDays[openDays.length - 1] || order.preferred || PICKUP.days[PICKUP.days.length - 1];
  if (fits_(order, used, preferred)) return preferred;
  return openDays.find(d => d !== preferred && fits_(order, used, d)) || preferred;
}

function readOrder_(response) {
  const order = { qty: {}, preferred: '', name: '', email: '', summary: [] };
  ITEMS.forEach(i => { order.qty[i.title] = 0; });
  for (const answer of response.getItemResponses()) {
    const title = answer.getItem().getTitle().trim();
    const values = [].concat(answer.getResponse());
    order.summary.push(`${title}: ${values.join(', ')}`);
    if (title in order.qty) order.qty[title] = values.reduce((sum, v) => sum + quantity_(v), 0);
    else if (title === PICKUP.title) order.preferred = String(values[0]);
    else if (title === NAME_TITLE) order.name = String(values[0]).trim();
    else if (title === EMAIL_TITLE) order.email = String(values[0]).trim();
  }
  return order;
}

// ---------- Updating the form ----------

function updateForm_(form, used) {
  const originals = JSON.parse(PropertiesService.getScriptProperties().getProperty('originals') || '{}');
  const summary = [];

  // A single order goes to one day, so it can't be bigger than the most any open day has left.
  for (const item of ITEMS) {
    const left = PICKUP.days.map(d => isClosed_(d) ? 0 : Math.max(0, item.perDay[d] - used[d][item.title]));
    const fits = (originals[item.title] || []).filter(v => quantity_(v) <= Math.max(...left));
    setChoices_(findItem_(form, item.title), fits.length ? fits : [SOLD_OUT_CHOICE]);
    PICKUP.days.forEach((d, n) => summary.push(`${d}  ${item.title}  ${left[n]} of ${item.perDay[d]} ${item.unit} left`));
  }

  // Offer only the days that are still taking orders and have something left.
  const stillOpen = PICKUP.days.filter(d => !isClosed_(d));
  const open = (originals[PICKUP.title] || PICKUP.days)
    .filter(d => stillOpen.includes(d) && ITEMS.some(i => i.perDay[d] !== undefined && used[d][i.title] < i.perDay[d]));
  if (open.length) setChoices_(findItem_(form, PICKUP.title), open);

  form.setCustomClosedFormMessage(stillOpen.length ? CLOSED_MESSAGE : CLOSED_FOR_WEEK_MESSAGE);
  form.setAcceptingResponses(open.length > 0);
  summary.push(`Form is ${open.length ? 'open' : stillOpen.length ? 'closed (sold out)' : 'closed until the new week opens'}.`);
  return summary;
}

function ensurePickupQuestion_(form) {
  const existing = form.getItems().find(i => i.getTitle().trim() === PICKUP.title);
  if (existing) { existing.setHelpText(PICKUP.help); return; }
  const question = form.addMultipleChoiceItem()
    .setTitle(PICKUP.title)
    .setHelpText(PICKUP.help)
    .setChoiceValues(PICKUP.days)
    .setRequired(true);
  // Place it right after the last quantity question.
  const after = Math.max(...ITEMS.map(i => findItem_(form, i.title).getIndex()));
  form.moveItem(question.getIndex(), after + 1);
}

// ---------- Order Sheet and emails ----------

// Writes the confirmed day next to the order in the linked response Sheet, if there is one.
function recordPickup_(form, response, order, day) {
  if (form.getDestinationType() !== FormApp.DestinationType.SPREADSHEET) return;
  const book = SpreadsheetApp.openById(form.getDestinationId());
  const sheet = book.getSheets().find(s => s.getFormUrl()) || book.getSheets()[0];
  const note = day + (order.preferred && day !== order.preferred ? ` (moved from ${order.preferred})` : '');
  const when = response.getTimestamp().getTime();

  for (let attempt = 0; attempt < 3; attempt++) {   // the new row can take a moment to appear
    const width = Math.max(sheet.getLastColumn(), 1);
    const header = sheet.getRange(1, 1, 1, width).getValues()[0].map(String);
    let col = header.indexOf(PICKUP_COLUMN) + 1;
    if (!col) { col = width + 1; sheet.getRange(1, col).setValue(PICKUP_COLUMN); }
    let weekCol = header.indexOf(WEEK_COLUMN) + 1;
    if (!weekCol) { weekCol = Math.max(width, col) + 1; sheet.getRange(1, weekCol).setValue(WEEK_COLUMN); }
    const emailCol = header.indexOf(EMAIL_TITLE);
    const rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues() : [];
    for (let r = rows.length - 1; r >= 0; r--) {
      const stamp = rows[r][0];
      const sameTime = stamp instanceof Date && Math.abs(stamp.getTime() - when) < 3000;
      const sameEmail = emailCol < 0 || String(rows[r][emailCol]).trim().toLowerCase() === order.email.toLowerCase();
      if (sameTime && sameEmail) {
        sheet.getRange(r + 2, col).setValue(note);
        sheet.getRange(r + 2, weekCol).setValue(weekLabel_());
        return;
      }
    }
    Utilities.sleep(2000);
  }
}

function emailMoved_(order, day) {
  if (!/@/.test(order.email)) return;
  const first = (order.name.split(/\s+/)[0] || 'there');
  const options = {
    to: order.email,
    name: SHOP_NAME,
    subject: `Your ${SHOP_NAME} order will be ready ${day}`,
    body:
      `Hi ${first},\n\n` +
      `Thank you so much for your order! Our ${order.preferred} batch is all spoken for, ` +
      `so your whole order will be ready for pickup on ${day} instead.\n\n` +
      `If ${day} doesn’t work for you, just reply to this email and we’ll sort it out.\n\n` +
      `${SHOP_NAME} ♡`,
  };
  if (ALERT_EMAIL) options.replyTo = ALERT_EMAIL;
  MailApp.sendEmail(options);
}

function alertOversold_(lines, fresh) {
  const to = ALERT_EMAIL || Session.getEffectiveUser().getEmail();
  const latest = fresh.length ? fresh[fresh.length - 1].order.summary : [];
  MailApp.sendEmail(to, `${SHOP_NAME}: an order went over a day’s limit`,
    'Two orders came in at almost the same time, so a day is slightly oversold:\n\n' +
    lines.join('\n') + '\n\nThe latest order was:\n' + latest.join('\n') +
    '\n\nYou may want to reach out to them. The form has already been updated.');
}

function alertLate_(order) {
  const to = ALERT_EMAIL || Session.getEffectiveUser().getEmail();
  MailApp.sendEmail(to, `${SHOP_NAME}: an order came in after this week’s cutoff`,
    'This order arrived just after orders closed, before the form finished closing:\n\n' +
    order.summary.join('\n') + '\n\nYou may want to let them know whether you can fit it in.');
}

// ---------- Weekly schedule ----------

function isClosed_(day) {
  const cut = cutoffs_()[day];
  return Boolean(cut) && Date.now() >= cut.getTime();
}

// This week's cutoff times: each is the first one after the week opened. A later pickup day's
// cutoff is never earlier than an earlier day's (matters only if the week is reset mid-week).
function cutoffs_() {
  const start = Number(PropertiesService.getScriptProperties().getProperty('weekStart') || Date.now());
  const result = {};
  let previous = start;
  for (const day of PICKUP.days) {
    const cut = SCHEDULE.cutoffs[day];
    if (!cut) continue;
    let when = nextWeekdayAt_(start, cut.day, cut.hour);
    if (when.getTime() < previous) when = nextWeekdayAt_(previous, cut.day, cut.hour);
    result[day] = when;
    previous = when.getTime();
  }
  return result;
}

// The first moment after `after` (ms) that falls on `dayName` at `hour`:00, in the script's time zone.
function nextWeekdayAt_(after, dayName, hour) {
  const tz = Session.getScriptTimeZone();
  const names = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
  for (let i = 0; i <= 8; i++) {
    const date = new Date(after + i * 86400000);
    if (names[Number(Utilities.formatDate(date, tz, 'u')) - 1] !== dayName) continue;
    const when = Utilities.parseDate(`${Utilities.formatDate(date, tz, 'yyyy-MM-dd')} ${hour}:00`, tz, 'yyyy-MM-dd H:mm');
    if (when.getTime() > after) return when;
  }
  throw new Error(`Couldn't work out the next ${dayName} at ${hour}:00.`);
}

// "Week of Nov 5", using the first pickup day's date
function weekLabel_() {
  const first = cutoffs_()[PICKUP.days[0]];
  if (!first) return '';
  return `Week of ${Utilities.formatDate(new Date(first.getTime() + 86400000), Session.getScriptTimeZone(), 'MMM d')}`;
}

// ---------- Small helpers ----------

// "3 bundles (12 cookies)" → 3, "Sold out this week" → 0
function quantity_(text) {
  const match = String(text).match(/\d+/);
  return match ? Number(match[0]) : 0;
}

function findItem_(form, title) {
  const item = form.getItems().find(i => i.getTitle().trim() === title);
  if (!item) throw new Error(`Couldn't find the question "${title}". Check the settings at the top of the script.`);
  return item;
}

function choiceValues_(item) {
  return typed_(item).getChoices().map(c => c.getValue());
}

function setChoices_(item, values) {
  if (choiceValues_(item).join('\n') !== values.join('\n')) typed_(item).setChoiceValues(values);
}

function typed_(item) {
  switch (item.getType()) {
    case FormApp.ItemType.MULTIPLE_CHOICE: return item.asMultipleChoiceItem();
    case FormApp.ItemType.LIST: return item.asListItem();
    case FormApp.ItemType.CHECKBOX: return item.asCheckboxItem();
    default: throw new Error(`"${item.getTitle()}" needs to be a multiple choice, dropdown, or checkbox question.`);
  }
}

function form_() {
  return FORM_ID ? FormApp.openById(FORM_ID) : FormApp.getActiveForm();
}
