const fs = require('fs');
const dir = 'e:/Hardware/wokwi_clon/frontend/public/component-svgs';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.svg') && !f.includes('-board'));

let html = '<!DOCTYPE html><html><body style="background:#111;color:#fff;font:11px monospace">\n';
files.forEach(f => {
  html += '<div style="display:inline-block;margin:4px;text-align:center;vertical-align:top">';
  html += '<img src="./' + f + '" width=100 height=70 style="background:#333;display:block;border:1px solid #555">';
  html += '<div style="max-width:100px;word-break:break-all">' + f.replace('wokwi-','').replace('.svg','') + '</div>';
  html += '</div>\n';
});
html += '</body></html>';
fs.writeFileSync(dir + '/test.html', html);
console.log('Written: ' + dir + '/test.html');
