// db-check.js — print all database tables cleanly
const Database = require('better-sqlite3');
const db = new Database('collab.db');

// helper to execute and print tables nicely
const all = (sql, params=[]) => db.prepare(sql).all(params);

const printTable = (title, rows) => {
  console.log(`\n== ${title} ==`);
  if (!rows || rows.length === 0) {
    console.log('(empty)\n');
  } else {
    console.table(rows);
  }
};

// 1️⃣ sessions
printTable('sessions',
  all(`SELECT id, created_at, closed_at FROM sessions ORDER BY id DESC`)
);

// 2️⃣ members
printTable('members',
  all(`SELECT session_id, name, joined_at, left_at FROM members ORDER BY joined_at DESC`)
);

// 3️⃣ questions
printTable('questions',
  all(`SELECT id, session_id, substr(text, 1, 100) AS text, set_at FROM questions ORDER BY set_at DESC`)
);

// 4️⃣ answers
printTable('answers',
  all(`SELECT id, session_id, name, substr(code, 1, 100) AS code, submitted_at, filename
       FROM answers ORDER BY submitted_at DESC`)
);

// 5️⃣ feedback (if table exists)
try {
  const feedback = all(`SELECT * FROM feedback`);
  printTable('feedback', feedback);
} catch (e) {
  console.log('\n(feedback table not found — skipped)');
}

// ✅ Optional: print list of all tables
const tables = all(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;`);
console.log('\n📋 Tables in database:');
console.table(tables);
