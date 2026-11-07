// Mock Whisper (9100) und Ollama (9101) fuer den Durchlauftest.
const http = require('http');
const fs = require('fs');
const log = (o) => fs.appendFileSync('/home/claude/e2e/mocks.log', JSON.stringify(o) + '\n');
http.createServer((req, res) => {
  let body = []; req.on('data', c => body.push(c)); req.on('end', () => {
    const buf = Buffer.concat(body); const s = buf.toString('latin1');
    const prompt = (s.match(/name="prompt"\r\n\r\n([^\r]*)/) || [])[1] || '';
    const lang = (s.match(/name="language"\r\n\r\n([^\r]*)/) || [])[1] || '';
    log({ whisper: true, bytes: buf.length, hasAudio: s.includes('FAKEAUDIO-0') && s.includes('FAKEAUDIO-2'), prompt: Buffer.from(prompt,'latin1').toString('utf8'), lang });
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({ text: 'Guten Tag. Der Blutdruck ist gut. Wir reduzieren Ramipril von 5 auf 2,5 Milligramm. Bitte in zwei Wochen zur Kontrolle beim Hausarzt. Zur Frage nach dem Schwindel: das kommt vermutlich vom Blutdruck.' }));
  });
}).listen(9100);
http.createServer((req, res) => {
  let body = []; req.on('data', c => body.push(c)); req.on('end', () => {
    const j = JSON.parse(Buffer.concat(body).toString());
    log({ ollama: true, model: j.model, user: j.messages[1].content.slice(0, 400) });
    const content = JSON.stringify({
      overview: 'Der Blutdruck ist gut. Ramipril wird reduziert.',
      findings: ['Blutdruck gut eingestellt'],
      medication_changes: [{ name: 'Ramipril', change: 'von 5 mg auf 2,5 mg' }],
      recommendations: [],
      next_steps: [{ text: 'Kontrolle beim Hausarzt', due: '2026-11-21' }],
      question_answers: [{ question_index: 0, answer: 'Vermutlich vom Blutdruck.' }],
      unclear: [],
      appointments: [{ title: 'Kontrolle Kardiologie', date: '2026-11-24', time: '', location: '' }],
      family_notes: ['Ramipril jetzt 2,5 mg statt 5 mg.'],
    });
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({ message: { content } }));
  });
}).listen(9101);
