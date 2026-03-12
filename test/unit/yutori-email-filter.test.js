const { isEventEmail } = require('../../src/sources/yutori/email-filter');

function htmlWithCategory(cat) {
  return `<p style="text-transform:uppercase"><a style="text-decoration-line:none">${cat}</a></p>`;
}

describe('isEventEmail', () => {
  // Should pass
  test('passes NYC underground music', () => {
    expect(isEventEmail('scout-test.html', htmlWithCategory('NYC underground music and film nights'))).toBe(true);
  });
  test('passes Manhattan Indie Events', () => {
    expect(isEventEmail('scout-test.html', htmlWithCategory('Manhattan Indie Events'))).toBe(true);
  });
  test('passes trivia', () => {
    expect(isEventEmail('scout-test.html', htmlWithCategory('Brooklyn Manhattan Trivia Nights'))).toBe(true);
  });
  test('passes film screenings', () => {
    expect(isEventEmail('scout-test.html', htmlWithCategory('NYC curated film screenings'))).toBe(true);
  });
  test('passes bar nights', () => {
    expect(isEventEmail('scout-test.html', htmlWithCategory('Curated NYC Bar Nights'))).toBe(true);
  });

  // Should fail — currently leaking through
  test('blocks AI LLMs Top News', () => {
    expect(isEventEmail('scout-test.html', htmlWithCategory('AI LLMs Top News'))).toBe(false);
  });
  test('blocks longevity', () => {
    expect(isEventEmail('scout-test.html', htmlWithCategory('Longevity anti-aging findings'))).toBe(false);
  });
  test('blocks YC Series A', () => {
    expect(isEventEmail('scout-yc-series-a.html', htmlWithCategory('YC Series A raises'))).toBe(false);
  });
  test('blocks social event research', () => {
    expect(isEventEmail('scout-test.html', htmlWithCategory('Social Event Research'))).toBe(false);
  });
  test('blocks by filename: longevity', () => {
    expect(isEventEmail('scout-longevity-klotho.html', htmlWithCategory('unknown'))).toBe(false);
  });
  test('blocks by filename: ai/llm', () => {
    expect(isEventEmail('scout-gpt-5-rolls-out.html', htmlWithCategory('unknown'))).toBe(false);
  });
  test('blocks by filename: nvidia', () => {
    expect(isEventEmail('scout-nvidia-s-2b-photonics.html', htmlWithCategory('unknown'))).toBe(false);
  });
});
