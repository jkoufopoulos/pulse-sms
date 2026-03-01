/**
 * Referral code store — generates, stores, looks up, and expires referral codes.
 * In-memory Map + debounced disk write to data/referrals.json.
 * Phone numbers hashed on disk via SHA-256 (same as preference-profile.js).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REFERRALS_PATH = path.join(__dirname, '../data/referrals.json');
const CODE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

// In-memory stores
const codes = new Map(); // code → { referringPhone, eventId, createdAt }
const attributions = new Map(); // phone → { referralCode, referringPhone, eventId, attributedAt }

let writeTimer = null;
let cleanupInterval = null;

function hashPhone(phone) {
  return crypto.createHash('sha256').update(phone).digest('hex').slice(0, 16);
}

/**
 * Generate an 8-char referral code for a phone+eventId pair.
 * Deduplicates: same phone+eventId returns existing unexpired code.
 */
function generateReferralCode(phone, eventId) {
  // Check for existing unexpired code for this phone+event
  for (const [code, entry] of codes) {
    if (entry.referringPhone === phone && entry.eventId === eventId) {
      if (Date.now() - new Date(entry.createdAt).getTime() < CODE_EXPIRY_MS) {
        return code;
      }
      // Expired — remove and generate fresh
      codes.delete(code);
      break;
    }
  }

  const code = crypto.randomBytes(6).toString('base64url').slice(0, 8);
  codes.set(code, {
    referringPhone: phone,
    eventId,
    createdAt: new Date().toISOString(),
  });
  scheduleDiskWrite();
  return code;
}

/**
 * Look up a referral code. Returns { referringPhone, eventId } or null if expired/missing.
 */
function lookupReferralCode(code) {
  const entry = codes.get(code);
  if (!entry) return null;
  if (Date.now() - new Date(entry.createdAt).getTime() >= CODE_EXPIRY_MS) {
    codes.delete(code);
    return null;
  }
  return { referringPhone: entry.referringPhone, eventId: entry.eventId };
}

/**
 * Record first-touch attribution for a new phone. Idempotent — skips if already attributed.
 */
function recordAttribution(newPhone, code) {
  if (attributions.has(newPhone)) return; // first-touch only
  const entry = codes.get(code);
  if (!entry) return;
  attributions.set(newPhone, {
    referralCode: code,
    referringPhone: entry.referringPhone,
    eventId: entry.eventId,
    attributedAt: new Date().toISOString(),
  });
  scheduleDiskWrite();
}

function scheduleDiskWrite() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      const data = {
        codes: {},
        attributions: {},
      };
      for (const [code, entry] of codes) {
        data.codes[code] = {
          referringPhone: hashPhone(entry.referringPhone),
          eventId: entry.eventId,
          createdAt: entry.createdAt,
        };
      }
      for (const [phone, entry] of attributions) {
        data.attributions[hashPhone(phone)] = {
          referralCode: entry.referralCode,
          referringPhoneHashed: entry.referringPhoneHashed || (entry.referringPhone ? hashPhone(entry.referringPhone) : 'unknown'),
          eventId: entry.eventId,
          attributedAt: entry.attributedAt,
        };
      }
      fs.writeFileSync(REFERRALS_PATH, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('Referral persist error:', err.message);
    }
  }, 1000);
}

function cleanupExpired() {
  const now = Date.now();
  let removed = 0;
  for (const [code, entry] of codes) {
    if (now - new Date(entry.createdAt).getTime() >= CODE_EXPIRY_MS) {
      codes.delete(code);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`Cleaned up ${removed} expired referral codes`);
    scheduleDiskWrite();
  }
}

/**
 * Load referrals from disk on boot.
 * Note: phone numbers are hashed on disk, so we load codes with hashed phones.
 * Lookups still work because we only need eventId from the code entry.
 */
function loadReferrals() {
  try {
    const data = JSON.parse(fs.readFileSync(REFERRALS_PATH, 'utf8'));
    if (data.codes) {
      for (const [code, entry] of Object.entries(data.codes)) {
        codes.set(code, {
          referringPhone: entry.referringPhone, // hashed from disk
          eventId: entry.eventId,
          createdAt: entry.createdAt,
        });
      }
    }
    if (data.attributions) {
      for (const [hashedPhone, entry] of Object.entries(data.attributions)) {
        attributions.set(hashedPhone, entry);
      }
    }
    console.log(`Loaded ${codes.size} referral codes, ${attributions.size} attributions`);
  } catch {
    // File doesn't exist yet — normal on first boot
  }

  // Start cleanup interval
  cleanupInterval = setInterval(cleanupExpired, CLEANUP_INTERVAL_MS);
}

function clearReferralInterval() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
}

module.exports = {
  generateReferralCode,
  lookupReferralCode,
  recordAttribution,
  loadReferrals,
  clearReferralInterval,
};
