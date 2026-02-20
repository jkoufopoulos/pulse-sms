const { makeEventId, normalizeExtractedEvent, normalizeEventName } = require('./shared');
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
const { fetchBAMEvents } = require('./bam');
const { fetchSmallsLiveEvents } = require('./smallslive');
const { fetchNYPLEvents } = require('./nypl');
const { searchTavilyEvents, fetchTavilyFreeEvents } = require('./tavily');
const { fetchTicketmasterEvents } = require('./ticketmaster');
const { fetchYutoriEvents } = require('./yutori');

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
  fetchBAMEvents,
  fetchSmallsLiveEvents,
  fetchNYPLEvents,
  fetchEventbriteComedy,
  fetchEventbriteArts,
  normalizeExtractedEvent,
  normalizeEventName,
  makeEventId,
  searchTavilyEvents,
  fetchTavilyFreeEvents,
  fetchTicketmasterEvents,
  fetchYutoriEvents,
};
