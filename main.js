// Playtime Goals: a daily goal (or limit) for time in game, with streaks.
//
// Time is kept as merged intervals rather than per-game totals, so two packs
// running at once count once, and a session that runs past midnight is split
// between the two days it belongs to. The Play screen card reads a summary
// this file keeps current in storage.

var DAY_MS = 86400000;
var KEEP_DAYS = 400;               // history kept, for streaks
var TICK_MS = 30000;               // summary refresh while a game runs

var state = { sessions: [], running: {}, announced: null };
var ticking = null;                // refresh while a game runs
var daily = null;                  // slow refresh that rolls the card over at midnight

function isV2() { return typeof mc2.apiVersion === "number" && mc2.apiVersion >= 2; }

// MARK: Time

/** Local calendar day of a moment, as YYYY-MM-DD. */
function dayKey(ms) {
  var d = new Date(ms);
  var m = d.getMonth() + 1, day = d.getDate();
  return d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
}

/** Local midnight at the start of the day after `ms`. */
function nextMidnight(ms) {
  var d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

/** Sort and join overlapping or touching intervals. */
function merge(intervals) {
  var sorted = intervals.filter(function (i) { return i[1] > i[0]; })
    .map(function (i) { return [i[0], i[1]]; })
    .sort(function (a, b) { return a[0] - b[0]; });
  var out = [];
  for (var k = 0; k < sorted.length; k++) {
    var last = out[out.length - 1];
    if (last && sorted[k][0] <= last[1]) last[1] = Math.max(last[1], sorted[k][1]);
    else out.push(sorted[k]);
  }
  return out;
}

/** Seconds played on each local day: { "2026-10-05": 3600 }. */
function secondsByDay(intervals) {
  var out = {};
  var merged = merge(intervals);
  for (var k = 0; k < merged.length; k++) {
    var start = merged[k][0], end = merged[k][1];
    while (start < end) {
      var cut = Math.min(end, nextMidnight(start));
      var key = dayKey(start);
      out[key] = (out[key] || 0) + (cut - start) / 1000;
      start = cut;
    }
  }
  return out;
}

/** Every interval, including games still running, up to `now`. */
function allIntervals(now) {
  var live = Object.keys(state.running).map(function (id) { return [state.running[id], now]; });
  return state.sessions.concat(live);
}

// MARK: Goals

function met(seconds, goalSeconds, atMost) {
  return atMost ? seconds <= goalSeconds : seconds >= goalSeconds;
}

/**
 * Days in a row the goal held. Today counts once it is met; until then the
 * streak running up to yesterday is still alive. For a limit ("at most"),
 * every day since the first one played counts, played or not.
 */
function streak(byDay, now, goalSeconds, atMost) {
  var days = Object.keys(byDay).sort();
  if (days.length === 0) return 0;
  var first = days[0];
  var today = dayKey(now);
  var todaySeconds = byDay[today] || 0;
  // Noon of a day, stepped by calendar date, so a daylight-saving change
  // can never skip or repeat a day.
  var d = new Date(now);
  var cursor = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);
  if (atMost) {
    if (todaySeconds > goalSeconds) return 0;
  } else if (todaySeconds < goalSeconds) {
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - 1, 12);
  }
  var count = 0;
  for (;;) {
    var key = dayKey(cursor.getTime());
    if (key < first || !met(byDay[key] || 0, goalSeconds, atMost)) break;
    count++;
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - 1, 12);
  }
  return count;
}

async function goal() {
  var minutes = Number(await mc2.settings.get("goalMinutes"));
  if (!(minutes > 0)) minutes = 60;
  var mode = await mc2.settings.get("mode");
  return { seconds: Math.round(minutes * 60), minutes: minutes, atMost: mode === "Play at most" };
}

// MARK: Storage

async function load() {
  var saved = await mc2.storage.get("state");
  if (saved && Array.isArray(saved.sessions)) {
    state.sessions = saved.sessions;
    state.announced = saved.announced || null;
  }
  // A game left running when MC² closed reports its full length in
  // game-exit, so nothing is lost by forgetting where it started.
  state.running = {};
}

async function save() {
  var cutoff = Date.now() - KEEP_DAYS * DAY_MS;
  state.sessions = merge(state.sessions).filter(function (i) { return i[1] >= cutoff; });
  await mc2.storage.set("state", { sessions: state.sessions, announced: state.announced });
}

/** What the Play screen card shows, recomputed now. */
async function refresh() {
  var now = Date.now();
  var g = await goal();
  var byDay = secondsByDay(allIntervals(now));
  var today = dayKey(now);
  var todaySeconds = Math.round(byDay[today] || 0);
  var week = [];
  var d = new Date(now);
  for (var k = 6; k >= 0; k--) {
    var key = dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - k, 12).getTime());
    week.push({ day: key, seconds: Math.round(byDay[key] || 0) });
  }
  var summary = {
    today: todaySeconds,
    goal: g.seconds,
    atMost: g.atMost,
    streak: streak(byDay, now, g.seconds, g.atMost),
    week: week,
    playing: Object.keys(state.running).length > 0,
    updatedAt: now,
  };
  await mc2.storage.set("summary", summary);
  await maybeAnnounce(summary, today);
  return summary;
}

async function maybeAnnounce(summary, today) {
  if (state.announced === today) return;
  if (!(await mc2.settings.get("announce"))) return;
  var minutes = Math.round(summary.goal / 60);
  if (!summary.atMost && summary.today >= summary.goal) {
    state.announced = today;
    await save();
    mc2.notify("Goal reached: " + minutes + " minutes today. " + streakText(summary.streak));
  } else if (summary.atMost && summary.today > summary.goal) {
    state.announced = today;
    await save();
    mc2.notify("That's today's " + minutes + " minutes. Time for a break.");
  }
}

function streakText(days) {
  return days === 1 ? "1 day streak." : days + " day streak.";
}

// MARK: Events

function startTicking() {
  if (ticking === null) ticking = setInterval(function () { refresh(); }, TICK_MS);
}

function stopTicking() {
  if (ticking !== null && Object.keys(state.running).length === 0) {
    clearInterval(ticking);
    ticking = null;
  }
}

async function onLaunch(e) {
  if (!e || !e.id) return;
  state.running[e.id] = Date.now();
  startTicking();
  await refresh();
}

async function onExit(e) {
  if (!e) return;
  var now = Date.now();
  var seconds = Number(e.seconds);
  var start = seconds > 0 ? now - seconds * 1000 : state.running[e.id];
  delete state.running[e.id];
  if (start && start < now) state.sessions.push([start, now]);
  await save();
  stopTicking();
  await refresh();
}

if (!isV2()) {
  mc2.notify("Playtime Goals needs a newer version of MC². Update MC² to use it.");
} else {
  module.exports = {
    onload: async function () {
      await load();
      mc2.on("instance-launch", onLaunch);
      mc2.on("game-exit", onExit);
      mc2.on("settings-change", function () { state.announced = null; return refresh(); });
      mc2.addWidget({ id: "today", title: "Playtime", file: "widget.html", height: 150 });
      await refresh();
      // Past midnight the card moves to a new day even with nothing running.
      daily = setInterval(function () { refresh(); }, 10 * 60000);
    },
    onunload: async function () {
      if (ticking !== null) clearInterval(ticking);
      if (daily !== null) clearInterval(daily);
      ticking = null;
      daily = null;
      await save();
    },
    // For tests.
    _merge: merge,
    _secondsByDay: secondsByDay,
    _streak: streak,
    _dayKey: dayKey,
  };
}
