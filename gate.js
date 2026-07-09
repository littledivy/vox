// Social reasoning gate — shared between voice-e2e.html and eval.js
// Works in both browser and Node.js
//
// Three outcomes:
//   speak      — directly addressed, respond immediately
//   raise_hand — has something useful, signal availability but don't barge in
//   silent     — humans talking to each other, stay out

var GATE_CONFIG = {
  aiName: 'Vox',
  aiNames: ['vox', 'tara', 'hey ai', 'the ai'],
  gatePrompt: function(aiName) {
    return 'You are the social reasoning gate for "' + aiName + '", an AI in a multi-person meeting.\n\n' +
      'Given the recent conversation, answer ONLY one of: "speak", "hand", or "silent".\n\n' +
      '"speak" — ' + aiName + ' was directly addressed or a clear follow-up is expected.\n' +
      '"hand" — ' + aiName + ' has something useful to contribute (can answer a question, has relevant info) but was not directly asked. It should signal availability, not barge in.\n' +
      '"silent" — humans are talking to each other, small talk, or ' + aiName + ' has nothing useful to add.\n\n' +
      'Examples:\n' +
      '- "Hey ' + aiName + ', what time is standup?" → speak\n' +
      '- "Does anyone know the deploy schedule?" → hand\n' +
      '- "Can someone explain the caching layer?" → hand\n' +
      '- "I can\'t figure out this regex" → hand\n' +
      '- "How was your weekend?" → silent\n' +
      '- "Bob, can you review my PR?" → silent\n' +
      '- "Yeah I saw that too" → silent\n\n' +
      'Answer with ONLY "speak", "hand", or "silent".';
  },
};

// Returns { speak: true|false|"maybe"|"raise_hand", reason: string }
function ruleGate(speaker, text, transcript, config) {
  config = config || GATE_CONFIG;
  var lower = text.toLowerCase();
  var aiName = config.aiName;
  var aiNames = config.aiNames;

  // Rule 1: Direct addressing → SPEAK
  for (var i = 0; i < aiNames.length; i++) {
    var name = aiNames[i];
    if (lower.includes(name + ',') || lower.includes(name + ' ') || lower.endsWith(name) || lower.endsWith(name + '?') || lower.endsWith(name + '!') || lower.startsWith(name)) {
      var passingPhrases = ['testing '+name, 'tried '+name, 'using '+name, name+' yesterday', name+' crashed', name+' broke', 'about '+name];
      var isPassing = false;
      for (var p = 0; p < passingPhrases.length; p++) {
        if (lower.includes(passingPhrases[p])) { isPassing = true; break; }
      }
      if (!isPassing) return { speak: true, reason: 'name invoked' };
    }
  }

  // Rule 2: AI just spoke → immediate follow-up is for us
  var lastAI = -1;
  for (var i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].speaker === aiName) { lastAI = transcript.length - 1 - i; break; }
  }
  if (lastAI === 0) return { speak: true, reason: 'follow-up to AI' };

  // Rule 3 removed — let the LLM gate handle human conversation dynamics.
  // The LLM understands meeting phases and context better than heuristics.

  // Rule 4: Open question → likely raise_hand territory
  if (text.trim().endsWith('?')) return { speak: 'maybe', reason: 'question asked' };

  // Rule 5: One turn after AI spoke → might be follow-up
  if (lastAI === 1) return { speak: 'maybe', reason: 'possible follow-up' };

  return { speak: 'maybe', reason: 'unclear' };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ruleGate: ruleGate, GATE_CONFIG: GATE_CONFIG };
}
