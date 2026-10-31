/**
 * Belle Bakes – weekly order limits for the Pre-Order Google Form.
 *
 * What it does
 *   - After every order, adds up this week's loaves and cookie bundles.
 *   - Trims each question's choices so nobody can order more than is left
 *     (e.g. only "1 bundle" and "2 bundles" when 2 are left).
 *   - When an item is gone, its only choice becomes "Sold out this week".
 *   - When everything is gone, closes the form with a friendly sold-out message.
 *   - Every Saturday morning it starts a new week: all choices come back and the form reopens.
 *
 * Setup (once): in the form editor, ⋮ → Apps Script, paste this file, save,
 * choose "setup" in the toolbar and press Run, then approve the permissions.
 *
 * Handy functions to run by hand from the toolbar:
 *   resetWeek()   – start a new week right now
 *   checkStatus() – see this week's counts (shown in the Execution log)
 *   saveChoices() – after editing the quantity choices in the form (e.g. adding "5 loaves"),
 *                   run this so the script remembers the new full list
 */

// ---------- Settings ----------

// Question titles must match the form exactly. The number in each choice
// ("2 loaves", "3 bundles (12 cookies)") is what gets counted.
const LIMITS = [
  { title: 'Sourdough?', limit: 8, unit: 'loaves' },
  { title: 'How many cookies would you like?', limit: 15, unit: 'cookie bundles' },
];

const SOLD_OUT_CHOICE = 'Sold out this week';
const CLOSED_MESSAGE = 'We’re sold out this week! Thank you so much ♡ Check back soon for next week’s bakes.';

// When the new week starts (orders reopen).
const RESET_DAY = ScriptApp.WeekDay.SATURDAY;
const RESET_HOUR = 9;   // 9am, in the form owner's time zone

// Who gets a heads-up email if two orders land at once and an item goes over its limit.
// Leave blank to use the Google account that ran setup().
const ALERT_EMAIL = '';

// ---------- Setup and weekly reset ----------

function setup() {
  const form = FormApp.getActiveForm();
  const props = PropertiesService.getScriptProperties();

  // Remember the full list of choices the first time, so they can come back each week.
  if (!props.getProperty('originals')) {
    const originals = {};
    for (const cfg of LIMITS) {
      originals[cfg.title] = choiceValues_(findItem_(form, cfg.title)).filter(v => v !== SOLD_OUT_CHOICE);
    }
    props.setProperty('originals', JSON.stringify(originals));
  }
  if (!props.getProperty('weekStart')) props.setProperty('weekStart', String(Date.now()));

  // Replace any earlier triggers from this script, then add the two it needs.
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('onOrder').forForm(form).onFormSubmit().create();
  ScriptApp.newTrigger('resetWeek').timeBased().onWeekDay(RESET_DAY).atHour(RESET_HOUR).create();

  Logger.log(updateForm_().summary.join('\n'));
}

function saveChoices() {
  PropertiesService.getScriptProperties().deleteProperty('originals');
  setup();
}

function resetWeek() {
  PropertiesService.getScriptProperties().setProperty('weekStart', String(Date.now()));
  Logger.log(updateForm_().summary.join('\n'));   // restores every choice and reopens the form
}

function checkStatus() {
  const form = FormApp.getActiveForm();
  const used = usedThisWeek_(form);
  for (const cfg of LIMITS) {
    Logger.log(`${cfg.title}  ${used[cfg.title]} of ${cfg.limit} ${cfg.unit} ordered this week`);
  }
  Logger.log(`Form is ${form.isAcceptingResponses() ? 'open' : 'closed'}.`);
}

// ---------- Runs after every order ----------

function onOrder(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const { used } = updateForm_();
    const over = LIMITS.filter(cfg => used[cfg.title] > cfg.limit);
    if (over.length) alertOversold_(over, used, e);
  } finally {
    lock.releaseLock();
  }
}

// ---------- Helpers ----------

function updateForm_() {
  const form = FormApp.getActiveForm();
  const originals = JSON.parse(PropertiesService.getScriptProperties().getProperty('originals') || '{}');
  const used = usedThisWeek_(form);
  const summary = [];
  let anyLeft = false;

  for (const cfg of LIMITS) {
    const left = Math.max(0, cfg.limit - used[cfg.title]);
    const fits = (originals[cfg.title] || []).filter(v => quantity_(v) <= left);
    setChoices_(findItem_(form, cfg.title), fits.length ? fits : [SOLD_OUT_CHOICE]);
    if (fits.length) anyLeft = true;
    summary.push(`${cfg.title}  ${left} of ${cfg.limit} ${cfg.unit} left`);
  }

  form.setCustomClosedFormMessage(CLOSED_MESSAGE);
  form.setAcceptingResponses(anyLeft);
  summary.push(`Form is ${anyLeft ? 'open' : 'closed (sold out)'}.`);
  return { used, anyLeft, summary };
}

// Adds up quantities from every response since the week started.
function usedThisWeek_(form) {
  const since = new Date(Number(PropertiesService.getScriptProperties().getProperty('weekStart') || 0));
  const used = {};
  LIMITS.forEach(cfg => { used[cfg.title] = 0; });
  for (const response of form.getResponses(since)) {
    for (const answer of response.getItemResponses()) {
      const title = answer.getItem().getTitle();
      if (title in used) {
        used[title] += [].concat(answer.getResponse()).reduce((sum, v) => sum + quantity_(v), 0);
      }
    }
  }
  return used;
}

// "3 bundles (12 cookies)" → 3, "Sold out this week" → 0
function quantity_(text) {
  const match = String(text).match(/\d+/);
  return match ? Number(match[0]) : 0;
}

function findItem_(form, title) {
  const item = form.getItems().find(i => i.getTitle().trim() === title);
  if (!item) throw new Error(`Couldn't find the question "${title}". Check LIMITS at the top of the script.`);
  return item;
}

function choiceValues_(item) {
  return typed_(item).getChoices().map(c => c.getValue());
}

function setChoices_(item, values) {
  const current = choiceValues_(item);
  if (current.join('\n') !== values.join('\n')) typed_(item).setChoiceValues(values);
}

function typed_(item) {
  switch (item.getType()) {
    case FormApp.ItemType.MULTIPLE_CHOICE: return item.asMultipleChoiceItem();
    case FormApp.ItemType.LIST: return item.asListItem();
    case FormApp.ItemType.CHECKBOX: return item.asCheckboxItem();
    default: throw new Error(`"${item.getTitle()}" needs to be a multiple choice, dropdown, or checkbox question.`);
  }
}

function alertOversold_(over, used, e) {
  const to = ALERT_EMAIL || Session.getEffectiveUser().getEmail();
  const lines = over.map(cfg => `• ${cfg.title}: ${used[cfg.title]} ordered, limit ${cfg.limit} ${cfg.unit}`);
  const order = e && e.response
    ? e.response.getItemResponses().map(a => `${a.getItem().getTitle()}: ${[].concat(a.getResponse()).join(', ')}`)
    : [];
  MailApp.sendEmail(to, 'Belle Bakes: an order went over this week’s limit',
    'Two orders came in at almost the same time, so this week is slightly oversold:\n\n' +
    lines.join('\n') + '\n\nThe latest order was:\n' + order.join('\n') +
    '\n\nYou may want to reach out to them. The form has already been updated.');
}
