/**
 * User preference profile — silent background signal capture.
 * Tracks cross-session patterns (neighborhoods, categories, price/time preferences)
 * without any user-facing changes. Fire-and-forget writes after saveResponseFrame.
 */

const fs = require('fs');
const path = require('path');

const PROFILES_PATH = path.join(__dirname, '../data/profiles.json');
const profiles = new Map();
let writeTimer = null;

function blankProfile() {
  return {
    neighborhoods: {},
    categories: {},
    subcategories: {},
    sessionCount: 0,
    pricePreference: 'any',
    timePreference: 'any',
    freeSessionCount: 0,
    totalPicksSessionCount: 0,
    lateTimeCount: 0,
    earlyTimeCount: 0,
    timedSessionCount: 0,
    lastActiveDate: null,
    createdAt: null,
    proactiveOptIn: false,
    proactiveOptInDate: null,
    proactiveOptInPromptedAt: null,
  };
}

function getProfile(phone) {
  return profiles.get(phone) || blankProfile();
}

async function updateProfile(phone, { neighborhood, filters, responseType }) {
  try {
    const profile = profiles.has(phone) ? profiles.get(phone) : blankProfile();
    const now = new Date().toISOString().slice(0, 10);

    // Always: increment sessionCount, update dates
    profile.sessionCount++;
    profile.lastActiveDate = now;
    if (!profile.createdAt) profile.createdAt = now;

    // Only increment neighborhood/category on actual picks
    if (responseType === 'event_picks' || responseType === 'more') {
      if (neighborhood) {
        profile.neighborhoods[neighborhood] = (profile.neighborhoods[neighborhood] || 0) + 1;
      }
      if (filters?.category) {
        profile.categories[filters.category] = (profile.categories[filters.category] || 0) + 1;
      }
      if (filters?.subcategory) {
        profile.subcategories[filters.subcategory] = (profile.subcategories[filters.subcategory] || 0) + 1;
      }
      profile.totalPicksSessionCount++;
      if (filters?.free_only) {
        profile.freeSessionCount++;
      }
      if (filters?.time_after && /^\d{2}:\d{2}$/.test(filters.time_after)) {
        profile.timedSessionCount++;
        const hour = parseInt(filters.time_after.split(':')[0], 10);
        if (hour >= 21 || hour <= 5) {
          profile.lateTimeCount++;
        } else if (hour <= 20) {
          profile.earlyTimeCount++;
        }
      }

      // Recalculate derived fields
      if (profile.totalPicksSessionCount > 0) {
        profile.pricePreference = (profile.freeSessionCount / profile.totalPicksSessionCount) > 0.5 ? 'free' : 'any';
      }
      if (profile.timedSessionCount > 0) {
        if ((profile.lateTimeCount / profile.timedSessionCount) > 0.5) {
          profile.timePreference = 'late';
        } else if ((profile.earlyTimeCount / profile.timedSessionCount) > 0.5) {
          profile.timePreference = 'early';
        } else {
          profile.timePreference = 'any';
        }
      }
    }

    profiles.set(phone, profile);
    scheduleDiskWrite();
  } catch (err) {
    console.error('Profile update error:', err.message);
  }
}

function scheduleDiskWrite() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      const data = {};
      for (const [phone, profile] of profiles) {
        data[phone] = profile;
      }
      fs.writeFileSync(PROFILES_PATH, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('Profile persist error:', err.message);
    }
  }, 1000);
}

function deriveFiltersFromProfile(profile) {
  if (!profile || profile.sessionCount === 0) return {};

  const result = {};

  // Top category (merged categories + subcategories, ranked)
  const merged = {};
  for (const [cat, count] of Object.entries(profile.categories || {})) {
    merged[cat] = (merged[cat] || 0) + count;
  }
  for (const [sub, count] of Object.entries(profile.subcategories || {})) {
    merged[sub] = (merged[sub] || 0) + count;
  }
  const topCat = Object.entries(merged).sort((a, b) => b[1] - a[1])[0];
  if (topCat) result.category = topCat[0];

  if (profile.pricePreference === 'free') result.free_only = true;
  if (profile.timePreference === 'late') result.time_after = '21:00';
  if (profile.timePreference === 'early') result.time_after = '18:00';

  return result;
}

function getTopNeighborhood(profile) {
  if (!profile?.neighborhoods) return null;
  const entries = Object.entries(profile.neighborhoods);
  if (entries.length === 0) return null;
  return entries.sort((a, b) => b[1] - a[1])[0][0];
}

function getTopCategories(profile, n = 3) {
  if (!profile) return [];
  const merged = {};
  for (const [cat, count] of Object.entries(profile.categories || {})) {
    merged[cat] = (merged[cat] || 0) + count;
  }
  for (const [sub, count] of Object.entries(profile.subcategories || {})) {
    merged[sub] = (merged[sub] || 0) + count;
  }
  return Object.entries(merged)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key]) => key);
}

function getOptInEligibleUsers() {
  const eligible = [];
  for (const [phone, profile] of profiles) {
    if (profile.proactiveOptIn) eligible.push(phone);
  }
  return eligible;
}

function loadProfiles() {
  try {
    const data = JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'));
    for (const [phone, profile] of Object.entries(data)) {
      profiles.set(phone, profile);
    }
    console.log(`Loaded ${profiles.size} user profiles`);
  } catch {
    // File doesn't exist yet — normal on first boot
  }
}

function exportProfiles() {
  const data = {};
  for (const [phone, profile] of profiles) {
    data[phone] = profile;
  }
  return data;
}

// For testing: clear in-memory profiles and cancel pending writes
function _resetForTest() {
  profiles.clear();
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
}

module.exports = {
  getProfile,
  updateProfile,
  deriveFiltersFromProfile,
  getTopNeighborhood,
  getTopCategories,
  getOptInEligibleUsers,
  loadProfiles,
  exportProfiles,
  _resetForTest,
};
