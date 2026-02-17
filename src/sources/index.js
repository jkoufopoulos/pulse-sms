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
  fetchEventbriteComedy,
  fetchEventbriteArts,
  normalizeExtractedEvent,
  makeEventId,
  searchTavilyEvents,
  fetchTavilyFreeEvents,
};
