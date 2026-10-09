// Pure streak math for the weekly page — kept out of the routes so it is
// unit-testable and reusable (Ramadan summaries will use it too).
//
// Tone rules (product decision): streaks celebrate consistency (istiqāmah),
// never shame gaps. A streak day only requires ≥1 prayer marked done.

function doneCountsByDate(responses, prayers) {
  const byDate = {};
  for (const r of responses) {
    if (r.status !== "done") continue;
    if (prayers && !prayers.includes(r.prayer_name)) continue; // skip 'Fast' rows etc.
    byDate[r.date] = (byDate[r.date] || 0) + 1;
  }
  return byDate;
}

function shiftDate(dateStr, deltaDays) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

// Consecutive days (ending today, or yesterday if today has nothing yet —
// an in-progress today must not break the streak) with ≥1 prayer done.
function currentStreak(doneByDate, todayDate) {
  let cursor = todayDate;
  if (!doneByDate[cursor]) cursor = shiftDate(cursor, -1); // today still open
  let streak = 0;
  while (streak < 366 && doneByDate[cursor]) {
    streak++;
    cursor = shiftDate(cursor, -1);
  }
  return streak;
}

// Longest run of ≥1-prayer days within the given month prefix (YYYY-MM).
function bestStreakInMonth(doneByDate, monthPrefix, todayDate) {
  const daysInMonth = new Date(Number(monthPrefix.slice(0, 4)), Number(monthPrefix.slice(5, 7)), 0).getDate();
  let best = 0, run = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${monthPrefix}-${String(d).padStart(2, "0")}`;
    if (date > todayDate) break; // don't count the future
    run = doneByDate[date] ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

// Gentle monthly figures: active days, perfect days (5/5), total prayers done.
function monthSummary(doneByDate, monthPrefix, todayDate) {
  let daysActive = 0, fullDays = 0, totalDone = 0;
  const daysInMonth = new Date(Number(monthPrefix.slice(0, 4)), Number(monthPrefix.slice(5, 7)), 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${monthPrefix}-${String(d).padStart(2, "0")}`;
    if (date > todayDate) break;
    const n = doneByDate[date] || 0;
    if (n > 0) daysActive++;
    if (n >= 5) fullDays++;
    totalDone += n;
  }
  return { daysActive, fullDays, totalDone };
}

module.exports = { doneCountsByDate, shiftDate, currentStreak, bestStreakInMonth, monthSummary };
