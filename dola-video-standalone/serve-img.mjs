import http from 'node:http';
import fs from 'node:fs';

const s = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Content-Type', 'image/png');
  fs.createReadStream('D:\\daima\\2\\8649aea7a5af21478fed210a4a6354fb.png').pipe(res);
});
s.listen(19876, () => console.log('serving image on http://localhost:19876'));
