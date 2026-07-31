const good = 'هل اقدر اخد شاور بيه';
// same bytes decoded as latin-1 -> what mojibake looks like
const bad = Buffer.from(good, 'utf8').toString('latin1');
for (const [label, message] of [['intact', good], ['mojibake', bad]]) {
  const r = await fetch('http://localhost:3000/send', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'ig', subscriberId: 123, message }),
  });
  const j = await r.json();
  console.log(`${label.padEnd(9)} -> type=${j.type ?? 'sendfail(classified ok)'}`);
}
