const { makeEventId, normalizeExtractedEvent } = require('./shared');
const { fetchSkintEvents } = require('./skint');
const { fetchEventbriteEvents, fetchEventbriteComedy, fetchEventbriteArts } = require('./eventbrite');
const { fetchSongkickEvents } = require('./songkick');
const { fetchDiceEvents } = require('./dice');
const { fetchRAEvents } = require('./ra');
const { fetchNYCParksEvents } = require('./nyc-parks');
const { fetchBrooklynVeganEvents } = require('./brooklynvegan');
const { fetchNonsenseNYC } = require('./nonsense');
const { fetchOhMyRockness } = require('./ohmyrockness');
const { fetchDoNYCEvents } = require('./donyc');
const { searchTavilyEvents, fetchTavilyFreeEvents } = require('./tavily');

module.exports = {
  fetchSkintEvents,
  fetchEventbriteEvents,
  fetchSongkickEvents,
  fetchDiceEvents,
  fetchRAEvents,
  fetchNYCParksEvents,
  fetchBrooklynVeganEvents,
  fetchNonsenseNYC,
  fetchOhMyRockness,
  fetchDoNYCEvents,
  fetchEventbriteComedy,
  fetchEventbriteArts,
  normalizeExtractedEvent,
  makeEventId,
  searchTavilyEvents,
  fetchTavilyFreeEvents,
};
