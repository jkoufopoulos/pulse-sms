Run the Pulse eval suite. Usage: `/eval [scope]`

Scopes:
- `/eval` or `/eval all` — full suite (unit tests + scenario + regression, ~10 min)
- `/eval unit` — unit tests only (`npm test`, $0, ~2s)
- `/eval scenarios` — scenario evals only (293 scenarios against Railway, ~5 min)
- `/eval regression` — regression evals only (124 scenarios against Railway, ~5 min)
- `/eval quality` — quality evals (15 golden conversations, ~$0.50, ~5 min)
- `/eval quick` — unit tests + send 3 test SMS to Railway to verify hot path

Run in this working directory: `/Users/justinkoufopoulos/Projects/pulse-sms`

For each scope:

**unit**: Run `npm test`. Report pass/fail count.

**scenarios**: Run `node scripts/run-scenario-evals.js --url https://web-production-c8fdb.up.railway.app` (600s timeout). Read the saved report from `data/reports/scenario-eval-*.json` (most recent). Report: total/passed/failed, code eval breakdown, top 5 failing scenarios with their conversation.

**regression**: Run `node scripts/run-regression-evals.js --url https://web-production-c8fdb.up.railway.app` (600s timeout). Read the saved report. Report: per-principle pass rates, failing assertions.

**quality**: Run `npm run eval:quality` (300s timeout). Report dimension scores.

**quick**: Run `npm test`, then send 3 curl requests to Railway test endpoint:
1. `curl -s https://web-production-c8fdb.up.railway.app/api/sms/test -X POST -d "Body=hey&From=%2B12125559999"` — expect ok:true
2. `curl -s https://web-production-c8fdb.up.railway.app/api/sms/test -X POST -d "Body=bushwick&From=%2B12125559999"` — expect ok:true with picks
3. `curl -s https://web-production-c8fdb.up.railway.app/api/sms/test -X POST -d "Body=more&From=%2B12125559999"` — expect ok:true

Report: unit test results + each SMS response body (first 150 chars).

**all**: Run unit, scenarios, regression sequentially. Summarize all results.

After any eval run, compare pass rates against previous reports if available in `data/reports/`. Flag regressions.

Arguments: $ARGUMENTS
