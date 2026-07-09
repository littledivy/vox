#!/usr/bin/env node
// Gate eval — runs scenarios against the shared gate logic, prints results.
// Usage: GROQ_API_KEY=... node eval.js [--rules-only]

const { ruleGate, GATE_CONFIG } = require('./gate.js');

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const MODEL_GATE = 'llama-3.1-8b-instant';
const RULES_ONLY = process.argv.includes('--rules-only');

// --- LLM gate (Groq direct) → "speak" | "hand" | "silent" ---
async function llmGate(transcript) {
  if (!GROQ_API_KEY) return null;

  const recent = transcript.slice(-6).map(m => `[${m.speaker}]: ${m.text}`).join('\n');
  const prompt = `Recent conversation:\n${recent}\n\nWhat should ${GATE_CONFIG.aiName} do?`;

  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL_GATE,
        messages: [
          { role: 'system', content: GATE_CONFIG.gatePrompt(GATE_CONFIG.aiName) },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 5,
      }),
    });
    const data = await resp.json();
    const answer = (data.choices?.[0]?.message?.content || '').trim().toLowerCase();
    if (answer.startsWith('speak')) return 'speak';
    if (answer.startsWith('hand')) return 'hand';
    return 'silent';
  } catch (e) {
    return null;
  }
}

// --- Scenarios ---
// expect: "speak" | "hand" | "silent"
const SCENARIOS = [
  {
    name: "Direct addressing",
    turns: [
      { speaker: "Alice", text: "Hey everyone, morning!", expect: "silent" },
      { speaker: "Bob", text: "Morning Alice!", expect: "silent" },
      { speaker: "Alice", text: "Vox, what's on the agenda today?", expect: "speak" },
      { speaker: "Alice", text: "Great, thanks!", expect: "speak" },
      { speaker: "Bob", text: "Alice, can you share the doc?", expect: "silent" },
    ]
  },
  {
    name: "Human back-and-forth",
    turns: [
      { speaker: "Alice", text: "Did you see the PR?", expect: "silent" },
      { speaker: "Bob", text: "Yeah, I left some comments", expect: "silent" },
      { speaker: "Alice", text: "The tests are failing though", expect: "silent" },
      { speaker: "Bob", text: "I think it's the config, let me check", expect: "silent" },
      { speaker: "Alice", text: "Okay let me know", expect: "silent" },
    ]
  },
  {
    name: "Open question to the room",
    turns: [
      { speaker: "Alice", text: "Does anyone know when the deploy is?", expect: "hand" },
    ]
  },
  {
    name: "Question answered by human",
    turns: [
      { speaker: "Alice", text: "What time is the meeting?", expect: "hand" },
      { speaker: "Bob", text: "3pm I think", expect: "silent" },
      { speaker: "Alice", text: "Thanks Bob", expect: "silent" },
    ]
  },
  {
    name: "Implicit redirect to AI",
    turns: [
      { speaker: "Alice", text: "I can't figure out this regex", expect: "hand" },
      { speaker: "Bob", text: "Maybe ask Vox?", expect: "speak" },
    ]
  },
  {
    name: "AI in conversation then humans pivot",
    turns: [
      { speaker: "Alice", text: "Vox, summarize the last standup", expect: "speak" },
      { speaker: "Alice", text: "Cool. Bob, are you blocked on anything?", expect: "silent" },
      { speaker: "Bob", text: "Nah, I'm good", expect: "silent" },
      { speaker: "Alice", text: "Great, let's wrap up then", expect: "silent" },
    ]
  },
  {
    name: "Multiple questions interleaved",
    turns: [
      { speaker: "Alice", text: "Hey Vox, how's the build looking?", expect: "speak" },
      { speaker: "Bob", text: "Also Vox, can you check the error logs?", expect: "speak" },
    ]
  },
  {
    name: "Small talk",
    turns: [
      { speaker: "Alice", text: "How was your weekend?", expect: "silent" },
      { speaker: "Bob", text: "Pretty good, went hiking. You?", expect: "silent" },
      { speaker: "Alice", text: "Just relaxed at home, it was nice", expect: "silent" },
      { speaker: "Bob", text: "Nice, we should plan a team outing", expect: "silent" },
    ]
  },
  {
    name: "Awkward silence after technical question",
    turns: [
      { speaker: "Alice", text: "Can someone explain how the caching layer works?", expect: "hand" },
    ]
  },
  {
    name: "AI mentioned in passing",
    turns: [
      { speaker: "Alice", text: "I was testing Vox yesterday and it crashed", expect: "silent" },
      { speaker: "Bob", text: "Oh yeah, I saw that in the logs", expect: "silent" },
    ]
  },
  {
    name: "Help request without naming AI",
    turns: [
      { speaker: "Alice", text: "I need help writing a SQL query for the report", expect: "hand" },
    ]
  },
  {
    name: "Debate between humans",
    turns: [
      { speaker: "Alice", text: "I think we should use Postgres", expect: "silent" },
      { speaker: "Bob", text: "No way, DynamoDB is better for this", expect: "silent" },
      { speaker: "Alice", text: "The latency requirements won't work with Dynamo", expect: "silent" },
      { speaker: "Bob", text: "What are the actual latency requirements?", expect: "silent" },
      { speaker: "Alice", text: "Sub 50ms p99", expect: "silent" },
    ]
  },
  {
    name: "Debate then asked to weigh in",
    turns: [
      { speaker: "Alice", text: "I think we should use Postgres", expect: "silent" },
      { speaker: "Bob", text: "No way, DynamoDB is better for this", expect: "silent" },
      { speaker: "Alice", text: "Vox, what do you think?", expect: "speak" },
    ]
  },
];

// --- Runner ---
async function runScenario(scenario) {
  const transcript = [];
  const results = [];

  for (const turn of scenario.turns) {
    transcript.push({ speaker: turn.speaker, text: turn.text, ts: Date.now() });

    const t0 = performance.now();
    const rule = ruleGate(turn.speaker, turn.text, transcript);
    let decision, info;

    if (rule.speak === true) {
      decision = 'speak';
      info = `rule: ${rule.reason}`;
    } else if (rule.speak === false) {
      decision = 'silent';
      info = `rule: ${rule.reason}`;
    } else if (!RULES_ONLY && GROQ_API_KEY) {
      const llm = await llmGate(transcript);
      if (llm === null) {
        decision = 'silent';
        info = `rule: ${rule.reason} → LLM error`;
      } else {
        decision = llm;
        info = `rule: ${rule.reason} → LLM: ${decision}`;
      }
    } else {
      decision = 'silent';
      info = `rule: ${rule.reason} (no LLM)`;
    }

    const ms = Math.round(performance.now() - t0);
    const pass = decision === turn.expect;

    // Simulate AI response in transcript when it speaks
    if (decision === 'speak') {
      transcript.push({ speaker: GATE_CONFIG.aiName, text: '(responded)', ts: Date.now() });
    }

    results.push({ turn, decision, pass, info, ms });
  }

  return results;
}

// --- Display helpers ---
function decColor(dec) {
  if (dec === 'speak') return '\x1b[32m';
  if (dec === 'hand') return '\x1b[33m';
  return '\x1b[90m';
}

async function main() {
  if (!RULES_ONLY && !GROQ_API_KEY) {
    console.log('\x1b[33m⚠ GROQ_API_KEY not set — running rules-only (use --rules-only to suppress)\x1b[0m\n');
  }

  const mode = RULES_ONLY ? 'rules-only' : (GROQ_API_KEY ? 'rules + LLM' : 'rules-only');
  console.log(`\x1b[36mvox gate eval\x1b[0m  (${mode})  \x1b[90mspeak | hand | silent\x1b[0m\n`);

  let totalPass = 0, totalFail = 0, totalMs = 0, totalTurns = 0;

  for (const scenario of SCENARIOS) {
    const results = await runScenario(scenario);
    const pass = results.filter(r => r.pass).length;
    const total = results.length;
    const pct = Math.round(pass / total * 100);
    const color = pct === 100 ? '\x1b[32m' : pct >= 70 ? '\x1b[33m' : '\x1b[31m';

    console.log(`${color}${pass === total ? '✓' : '✗'}\x1b[0m ${scenario.name}  ${color}${pass}/${total}\x1b[0m`);

    for (const r of results) {
      const icon = r.pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      const expect = `${decColor(r.turn.expect)}${r.turn.expect}\x1b[0m`;
      const got = `${decColor(r.decision)}${r.decision}\x1b[0m`;
      console.log(`  ${icon} [${r.turn.speaker}]: "${r.turn.text}"`);
      console.log(`      expect=${expect}  got=${got}  \x1b[90m${r.info}  ${r.ms}ms\x1b[0m`);
    }
    console.log();

    totalPass += pass;
    totalFail += total - pass;
    for (const r of results) { totalMs += r.ms; totalTurns++; }
  }

  // Summary
  const total = totalPass + totalFail;
  const pct = Math.round(totalPass / total * 100);
  const avgMs = Math.round(totalMs / totalTurns);
  const color = pct === 100 ? '\x1b[32m' : pct >= 80 ? '\x1b[33m' : '\x1b[31m';

  console.log('─'.repeat(50));
  console.log(`${color}${totalPass}/${total} passed (${pct}%)\x1b[0m  avg gate: ${avgMs}ms`);

  process.exit(totalFail > 0 ? 1 : 0);
}

main();
