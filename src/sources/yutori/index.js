const { fetchYutoriEvents } = require('./fetch');
const { preprocessYutoriHtml } = require('./html-preprocess');
const { isEventEmail, isTriviaEmail } = require('./email-filter');
const { parseTriviaEvents } = require('./trivia-parser');

module.exports = {
  fetchYutoriEvents,
  preprocessYutoriHtml,
  isEventEmail,
  isTriviaEmail,
  parseTriviaEvents,
};
