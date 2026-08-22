// MV3 service worker: sets up the daily alarm and handles both the alarm
// firing and manual "Check Now" requests from the popup.

import { performCheck, ensureDailyAlarm, DAILY_ALARM, RESUME_ALARM } from "./lib/scheduler.js";

chrome.runtime.onInstalled.addListener(() => {
  ensureDailyAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  ensureDailyAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DAILY_ALARM || alarm.name === RESUME_ALARM) {
    performCheck({ manual: false });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "CHECK_NOW") {
    performCheck({ manual: true }).then(sendResponse);
    return true; // keep the message channel open for the async response
  }
  return false;
});
