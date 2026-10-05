// F1 Baarovka Manager – backend (Google Apps Script web app bound to the sheet).
// Script Properties: GITHUB_TOKEN (fine-grained, this repo, Contents read/write), ADMIN_KEY.
// Deploy: Execute as "Me", access "Anyone".

var REPO = 'F1BaarovkaManager/F1Manager';
var PICKS_PATH = 'data/picks.json';
var SUBS_PATH = 'data/subscriptions.json';
var SHEET_NAME = 'Picky';

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || '';
  try {
    if (action === 'data') return json_({ ok: true, data: readFile_(PICKS_PATH).data });
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Neplatný požadavek' });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    switch (body.action) {
      case 'pick': return json_(savePick_(body));
      case 'subscribe': return json_(subscribe_(body));
      case 'unsubscribe': return json_(unsubscribe_(body));
      case 'results': return json_(saveResults_(body));
      case 'players': return json_(savePlayers_(body));
      default: return json_({ ok: false, error: 'Neznámá akce' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

function savePick_(b) {
  var picks = readFile_(PICKS_PATH).data;
  var player = String(b.player || '');
  var round = String(b.round || '');
  var race = (picks.races || []).filter(function (r) { return String(r.round) === round; })[0];
  var drivers = b.drivers;

  if ((picks.players || []).indexOf(player) === -1) throw new Error('Neznámý hráč');
  if (!race || race.cancelled) throw new Error('Neplatný závod');
  if (!Array.isArray(drivers) || drivers.length !== 5) throw new Error('Sestava musí mít 5 jezdců');
  var unique = {};
  drivers.forEach(function (d) {
    if (typeof d !== 'string' || !d || d.length > 40 || unique[d]) throw new Error('Neplatní jezdci');
    unique[d] = true;
  });
  if (typeof b.team !== 'string' || !b.team || b.team.length > 40) throw new Error('Neplatný tým');

  var timestamp = new Date().toISOString();
  var pick = { drivers: drivers, team: b.team, timestamp: timestamp };
  var saved = updateFile_(PICKS_PATH, 'Pick: ' + player + ' – ' + race.name, function (data) {
    data.picks = data.picks || {};
    data.picks[player] = data.picks[player] || {};
    data.picks[player][round] = pick;
  });

  appendSheetRow_([new Date(timestamp), player, race.name].concat(drivers, [b.team, b.totalCost || '']));
  return { ok: true, data: saved };
}

function subscribe_(b) {
  var picks = readFile_(PICKS_PATH).data;
  var player = String(b.player || '');
  var sub = b.subscription || {};
  if ((picks.players || []).indexOf(player) === -1) throw new Error('Neznámý hráč');
  if (typeof sub.endpoint !== 'string' || sub.endpoint.indexOf('https://') !== 0 || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    throw new Error('Neplatné zařízení');
  }
  updateFile_(SUBS_PATH, 'Notifications on: ' + player, function (data) {
    removeEndpoint_(data, sub.endpoint);
    data[player] = data[player] || [];
    data[player].push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, added: new Date().toISOString() });
  }, {});
  return { ok: true };
}

function unsubscribe_(b) {
  if (typeof b.endpoint !== 'string') throw new Error('Neplatné zařízení');
  updateFile_(SUBS_PATH, 'Notifications off', function (data) { removeEndpoint_(data, b.endpoint); }, {});
  return { ok: true };
}

function saveResults_(b) {
  checkAdmin_(b.adminKey);
  var round = String(b.round || '');
  if (!b.result || typeof b.result !== 'object') throw new Error('Chybí výsledky');
  var picks = readFile_(PICKS_PATH).data;
  var race = (picks.races || []).filter(function (r) { return String(r.round) === round; })[0];
  if (!race) throw new Error('Neplatný závod');
  var saved = updateFile_(PICKS_PATH, 'Results: ' + race.name, function (data) {
    data.raceResults = data.raceResults || {};
    data.raceResults[round] = b.result;
  });
  return { ok: true, data: saved };
}

function savePlayers_(b) {
  checkAdmin_(b.adminKey);
  if (!Array.isArray(b.players) || !b.players.length) throw new Error('Chybí hráči');
  var players = b.players.map(function (p) { return String(p).trim(); }).filter(String);
  var saved = updateFile_(PICKS_PATH, 'Update players list', function (data) { data.players = players; });
  return { ok: true, data: saved };
}

function checkAdmin_(key) {
  var expected = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
  if (!expected || key !== expected) throw new Error('Špatný admin klíč');
}

function removeEndpoint_(data, endpoint) {
  Object.keys(data).forEach(function (p) {
    data[p] = (data[p] || []).filter(function (s) { return s.endpoint !== endpoint; });
    if (!data[p].length) delete data[p];
  });
}

function appendSheetRow_(row) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
  sheet.appendRow(row);
}

// --- GitHub contents API ---

function github_(method, path, payload) {
  var token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  var options = {
    method: method,
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' }
  };
  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }
  return UrlFetchApp.fetch('https://api.github.com/repos/' + REPO + '/contents/' + path, options);
}

function readFile_(path, emptyValue) {
  var resp = github_('get', path);
  if (resp.getResponseCode() === 404 && emptyValue !== undefined) return { data: emptyValue, sha: null };
  if (resp.getResponseCode() !== 200) throw new Error('GitHub ' + resp.getResponseCode());
  var meta = JSON.parse(resp.getContentText());
  var text = Utilities.newBlob(Utilities.base64Decode(meta.content.replace(/\n/g, ''))).getDataAsString('UTF-8');
  return { data: JSON.parse(text), sha: meta.sha };
}

function updateFile_(path, message, mutate, emptyValue) {
  for (var attempt = 1; attempt <= 4; attempt++) {
    var file = readFile_(path, emptyValue);
    mutate(file.data);
    var payload = {
      message: message,
      content: Utilities.base64Encode(JSON.stringify(file.data, null, 2), Utilities.Charset.UTF_8)
    };
    if (file.sha) payload.sha = file.sha;
    var resp = github_('put', path, payload);
    var code = resp.getResponseCode();
    if (code === 200 || code === 201) return file.data;
    if (code !== 409 && code !== 422) throw new Error('GitHub ' + code);
    Utilities.sleep(300 * attempt);
  }
  throw new Error('Nepodařilo se uložit, zkus to znovu');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
