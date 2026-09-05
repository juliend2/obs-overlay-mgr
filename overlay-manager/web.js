import fs from 'fs'

export function serveFile(res, filePath, contentType, method = 'GET') {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    if (method === 'HEAD') {
      res.end();
      return;
    }
    res.end(data);
  });
}


