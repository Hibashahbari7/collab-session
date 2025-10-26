// db-check.js
const Database = require('better-sqlite3');
const db = new Database('collab.db');

const all = (q, p = []) => db.prepare(q).all(p);

console.log('== sessions ==');
console.table(all('SELECT * FROM sessions ORDER BY created_at DESC LIMIT 10'));

console.log('== members (active) ==');
console.table(all('SELECT session_id, name, joined_at, left_at FROM members WHERE left_at IS NULL ORDER BY joined_at DESC LIMIT 20'));

console.log('== questions (latest 5) ==');
console.table(all(`
  SELECT session_id,
         substr(text, 1, 50) || '...' AS preview,
         set_at
  FROM questions
  ORDER BY set_at DESC
  LIMIT 5
`));

console.log('== answers (latest 5) ==');
console.table(all(`
  SELECT session_id,
         student,
         length(code) AS size,
         created_at
  FROM answers
  ORDER BY created_at DESC
  LIMIT 5
`));

console.log('== feedback (latest 5) ==');
console.table(all(`
  SELECT session_id,
         to_student,
         substr(text, 1, 40) || '...' AS preview,
         created_at
  FROM feedback
  ORDER BY created_at DESC
  LIMIT 5
`));
