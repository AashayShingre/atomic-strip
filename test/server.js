// Minimal static file server for the probe test harness.
var http = require('http');
var fs = require('fs');
var path = require('path');
var root = path.join(__dirname, '..');
var types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
http.createServer(function (req, res) {
  var p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/test/probe-test.html';
  var file = path.join(root, p);
  fs.readFile(file, function (err, data) {
    if (err) { res.writeHead(404); res.end('not found: ' + p); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(8731, function () { console.log('serving on 8731'); });
