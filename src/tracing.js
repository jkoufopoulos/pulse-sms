// Arize Phoenix tracing bootstrap.
//
// MUST be required at the very top of server.js, before any module that
// imports @anthropic-ai/sdk — the instrumentation patches the Anthropic
// constructor at require time, so anything that pulls in the SDK first
// will miss tracing.
//
// Env vars:
//   PHOENIX_COLLECTOR_ENDPOINT — base URL (e.g. http://localhost:6006 for
//     local Docker, or https://app.phoenix.arize.com/s/<your-space> for cloud)
//   PHOENIX_API_KEY — bearer token if the collector requires auth
//   PHOENIX_DISABLED=true — skip init entirely
//
// Only Anthropic is auto-instrumented. Gemini fallback calls won't appear
// in Phoenix (no Node auto-instrumentation exists for @google/generative-ai
// as of 2026-05). Manual span instrumentation in llm.js could close that gap
// later if needed.

if (process.env.PHOENIX_DISABLED === 'true') {
  console.log('[phoenix] tracing disabled via PHOENIX_DISABLED');
} else {
  try {
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto');
    const { resourceFromAttributes } = require('@opentelemetry/resources');
    const { SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
    const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
    const { ATTR_SERVICE_NAME } = require('@opentelemetry/semantic-conventions');
    const { SEMRESATTRS_PROJECT_NAME } = require('@arizeai/openinference-semantic-conventions');
    const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
    const { AnthropicInstrumentation } = require('@arizeai/openinference-instrumentation-anthropic');

    const endpoint = process.env.PHOENIX_COLLECTOR_ENDPOINT || 'http://localhost:6006';
    const projectName = process.env.PHOENIX_PROJECT_NAME || 'pulse-sms';

    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: projectName,
        [SEMRESATTRS_PROJECT_NAME]: projectName,
      }),
      spanProcessors: [
        new SimpleSpanProcessor(
          new OTLPTraceExporter({
            url: endpoint.replace(/\/$/, '') + '/v1/traces',
            headers: process.env.PHOENIX_API_KEY
              ? { Authorization: `Bearer ${process.env.PHOENIX_API_KEY}` }
              : undefined,
          })
        ),
      ],
    });
    provider.register();

    const inst = new AnthropicInstrumentation();
    inst.manuallyInstrument(Anthropic);

    console.log(`[phoenix] tracing initialized — project=${projectName} endpoint=${endpoint}`);
  } catch (err) {
    // Fail open — tracing should never break the app.
    console.warn(`[phoenix] tracing init failed: ${err.message}`);
  }
}
