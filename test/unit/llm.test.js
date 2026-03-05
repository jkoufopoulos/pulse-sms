const { check } = require('../helpers');

console.log('\nllm:');

const { toGeminiTools, toAnthropicTools, convertSchemaToGemini } = require('../../src/llm');

const neutralTools = [
  {
    name: 'search_events',
    description: 'Search for events',
    parameters: {
      type: 'object',
      properties: {
        neighborhood: { type: 'string', description: 'NYC hood' },
        intent: { type: 'string', enum: ['new_search', 'refine'] },
        categories: { type: 'array', items: { type: 'string' } },
      },
      required: ['intent'],
    },
  },
  {
    name: 'respond',
    description: 'Respond conversationally',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'SMS text' },
      },
      required: ['message'],
    },
  },
];

// Gemini format
const gemini = toGeminiTools(neutralTools);
check('toGeminiTools wraps in functionDeclarations', !!gemini[0]?.functionDeclarations);
check('toGeminiTools has 2 tools', gemini[0].functionDeclarations.length === 2);
check('gemini tool name preserved', gemini[0].functionDeclarations[0].name === 'search_events');
check('gemini uses OBJECT type', gemini[0].functionDeclarations[0].parameters.type === 'OBJECT');
check('gemini uses STRING type for props', gemini[0].functionDeclarations[0].parameters.properties.neighborhood.type === 'STRING');
check('gemini handles array items', gemini[0].functionDeclarations[0].parameters.properties.categories.type === 'ARRAY');
check('gemini array items uppercased', gemini[0].functionDeclarations[0].parameters.properties.categories.items.type === 'STRING');

// Anthropic format
const anthropic = toAnthropicTools(neutralTools);
check('toAnthropicTools returns array', anthropic.length === 2);
check('anthropic tool has name', anthropic[0].name === 'search_events');
check('anthropic tool has input_schema', anthropic[0].input_schema.type === 'object');
check('anthropic preserves properties', !!anthropic[0].input_schema.properties.neighborhood);
check('anthropic preserves required', anthropic[0].input_schema.required.includes('intent'));

// convertSchemaToGemini
const schema = { type: 'object', properties: { x: { type: 'string' }, y: { type: 'array', items: { type: 'number' } } } };
const converted = convertSchemaToGemini(schema);
check('convertSchemaToGemini uppercases type', converted.type === 'OBJECT');
check('convertSchemaToGemini uppercases nested', converted.properties.x.type === 'STRING');
check('convertSchemaToGemini handles array items', converted.properties.y.items.type === 'NUMBER');
