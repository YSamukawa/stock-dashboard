// node src/build.js  → index.html（ライブラリと分析ロジックを1ファイルに埋め込む）
const fs = require('fs'); const path = require('path');
const here = __dirname;
const tpl = fs.readFileSync(path.join(here, 'template.html'), 'utf8');
const lwc = fs.readFileSync(path.join(here, 'vendor/lightweight-charts-4.2.3.standalone.production.js'), 'utf8').replace(/<\/script>/gi, '<\\/script>');
const an = fs.readFileSync(path.join(here, 'analytics.js'), 'utf8');
const app = fs.readFileSync(path.join(here, 'app.js'), 'utf8');
const tv = fs.readFileSync(path.join(here, 'tv.js'), 'utf8');
const out = tpl.replace('{{LWC}}', () => lwc).replace('{{ANALYTICS}}', () => an).replace('{{TV}}', () => tv).replace('{{APP}}', () => app);
fs.writeFileSync(path.join(here, '..', 'index.html'), out);
console.log('built index.html', out.length, 'bytes');
