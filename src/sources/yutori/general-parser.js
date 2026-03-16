// Day-of-week validation for recurring events — the only function still used from this module.

const DAY_NAMES = {
  sunday: 0, sundays: 0,
  monday: 1, mondays: 1,
  tuesday: 2, tuesdays: 2,
  wednesday: 3, wednesdays: 3,
  thursday: 4, thursdays: 4,
  friday: 5, fridays: 5,
  saturday: 6, saturdays: 6,
};

const DAY_PATTERN = new RegExp(`\\b(${Object.keys(DAY_NAMES).join('|')})\\b`, 'i');

/**
 * If an event name contains a day-of-week and its date_local doesn't match,
 * resolve date_local to the next matching day within 7 days.
 * Prevents "Trivia Thursdays" from appearing on Friday.
 */
function resolveDayOfWeekDate(event) {
  if (!event.name || !event.date_local) return event;

  const match = event.name.match(DAY_PATTERN);
  if (!match) return event;

  const targetDay = DAY_NAMES[match[1].toLowerCase()];
  const currentDate = new Date(event.date_local + 'T12:00:00');
  if (isNaN(currentDate.getTime())) return event;

  const currentDay = currentDate.getDay();
  if (currentDay === targetDay) return event;

  const daysAhead = (targetDay - currentDay + 7) % 7 || 7;
  const corrected = new Date(currentDate);
  corrected.setDate(corrected.getDate() + daysAhead);
  const newDate = corrected.toISOString().slice(0, 10);

  if (event.start_time_local && event.start_time_local.startsWith(event.date_local)) {
    event.start_time_local = event.start_time_local.replace(event.date_local, newDate);
  }
  if (event.end_time_local && event.end_time_local.startsWith(event.date_local)) {
    event.end_time_local = event.end_time_local.replace(event.date_local, newDate);
  }

  event.date_local = newDate;
  return event;
}

module.exports = { resolveDayOfWeekDate };
