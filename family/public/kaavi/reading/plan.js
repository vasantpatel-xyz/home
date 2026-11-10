// Kaavi's Reading Quest: the plan (data) and the rules (pure functions).
// Used by /reading/ (the mission page) and /reading/sheet/ (the printable sheet).
// The rules are unit-tested in scripts/test-local.mjs.
(function (root) {
  var TOTAL = 40; // stamps to collect: 4 books x about 10 reading days

  var STEPS = [
    { icon: '📖', t: 'Read one page out loud', s: '3 min · every word, every ending' },
    { icon: '🤫', t: 'Read the chapter quietly', s: '10 min · 1 or 2 chapters' },
    { icon: '✂️', t: 'Write two tricky words', s: '2 min · split them: un / fold / ed' },
    { icon: '✍️', t: 'Write your answer in your best handwriting', s: '5 min · full sentences, with a quote' },
    { icon: '👀', t: 'Grown-up check', s: 'Mom or Dad looks at your writing and gives stars' }
  ];

  // One comprehension skill per weekday. Every answer has the same three moves:
  // answer in a full sentence, copy a quote that proves it, explain what the quote shows.
  var PROMPTS = {
    1: { skill: 'Character trait', q: 'Pick one word that describes a character in today\'s chapter (brave, bossy, kind, careful, clever…).',
         how: ['Answer: "___ is ___."', 'Quote: In the book it says, "___."', 'Explain: "This shows ___ is ___ because ___."'], lines: 8 },
    2: { skill: 'Problem and action', q: 'What problem did the characters have today, and what did they do about it?',
         how: ['Answer: "The problem was ___."', 'Action: "To fix it, ___ decided to ___."', 'Quote: copy one sentence that shows it, in "quotation marks."'], lines: 8 },
    3: { skill: 'How a character changes', q: 'How is a character different now from the start of the book?',
         how: ['Answer: "At first, ___."', 'Then: "Now, ___."', 'Quote: copy one sentence that shows the change, in "quotation marks."'], lines: 8 },
    4: { skill: 'The lesson', q: 'What is the story teaching so far?',
         how: ['Answer: "One lesson is ___."', 'Reason: "I think this because ___."', 'Quote: copy one sentence that proves it, in "quotation marks."'], lines: 8 },
    5: { skill: 'Friday write-up', q: 'One neat paragraph about the main character: what they are like, how they have changed, and the lesson of the story.',
         how: ['Underline each part of the question first.', 'Write 5 to 7 sentences and use one quote.', 'This is the one Mom and Dad read tonight.'], lines: 12 }
  };
  var WEEKEND = { skill: 'Weekend bonus', q: 'What was the best part of what you read today, and why?',
                  how: ['Write 3 neat sentences.', 'Use one quote from the book.'], lines: 6 };

  var BOOKS = [
    { k: 'b1', t: 'The Boxcar Children', c: '#c0392b', q: 'What does each kid do to help the family survive? How do they feel about Grandfather at the start vs. the end?' },
    { k: 'b2', t: 'Surprise Island', c: '#1f8a8a', q: 'How do the kids make the island feel like home? What do they learn about the new people they meet?' },
    { k: 'b3', t: 'The Yellow House Mystery', c: '#b97a0d', q: 'What clues do they find, and who figures out what? What does each kid bring to solving it?' },
    { k: 'b4', t: 'Mystery Ranch', c: '#7a4fd6', q: 'How does Aunt Jane act at the start, and how does she change? What causes it?' }
  ];

  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parse(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !isNaN(parse(s)); }
  function isWeekend(d) { var w = d.getDay(); return w === 0 || w === 6; }

  // Saved state: { days: { 'YYYY-MM-DD': [bool x5] }, neat: { 'YYYY-MM-DD': 1..3 }, books: { b1: true } }
  function norm(s) {
    s = (s && typeof s === 'object') ? s : {};
    if (!s.days || typeof s.days !== 'object') s.days = {};
    if (!s.neat || typeof s.neat !== 'object') s.neat = {};
    if (!s.books || typeof s.books !== 'object') s.books = {};
    return s;
  }
  // A day earns its stamp only when all five steps are ticked, the grown-up check included.
  function dayDone(state, k) {
    var s = state.days[k];
    if (!Array.isArray(s) || s.length < STEPS.length) return false;
    for (var i = 0; i < STEPS.length; i++) if (s[i] !== true) return false;
    return true;
  }
  function stamps(state) {
    return Object.keys(state.days).filter(function (k) { return isDate(k) && dayDone(state, k); }).sort();
  }
  // Streak = reading days in a row. A missed weekday breaks it; weekends never break it
  // (and a weekend mission adds to it); today does not break it until today is over.
  function streaks(state, today) {
    var st = stamps(state).filter(function (k) { return k <= today; });
    if (!st.length) return { cur: 0, best: 0 };
    var set = {}; st.forEach(function (k) { set[k] = 1; });
    var d = parse(st[0]), end = parse(today), run = 0, best = 0, guard = 0;
    while (d <= end && guard++ < 4000) {
      var k = ymd(d);
      if (set[k]) { run++; if (run > best) best = run; }
      else if (!isWeekend(d) && k !== today) { run = 0; }
      d.setDate(d.getDate() + 1);
    }
    return { cur: run, best: best };
  }
  // The book he is on = the first one not marked finished (null when all four are done).
  function currentBook(state) {
    for (var i = 0; i < BOOKS.length; i++) if (!state.books[BOOKS[i].k]) return BOOKS[i];
    return null;
  }
  function promptFor(dateStr) {
    var dow = parse(dateStr).getDay();
    return PROMPTS[dow] || WEEKEND;
  }

  root.QUEST = { TOTAL: TOTAL, STEPS: STEPS, PROMPTS: PROMPTS, WEEKEND: WEEKEND, BOOKS: BOOKS,
    ymd: ymd, parse: parse, isDate: isDate, isWeekend: isWeekend, norm: norm, dayDone: dayDone,
    stamps: stamps, streaks: streaks, currentBook: currentBook, promptFor: promptFor };
})(typeof window !== 'undefined' ? window : globalThis);
