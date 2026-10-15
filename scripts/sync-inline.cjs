'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const file = path.join(root, 'index.html');
let html = fs.readFileSync(file, 'utf8');
const check = process.argv.includes('--check');
for (const name of ['rules', 'legacy-v1', 'advanced-v1', 'hybrid-v1']) {
  const source = fs.readFileSync(path.join(root, `js/${name}.js`), 'utf8').trimEnd();
  if (/<\/script/i.test(source)) throw new Error(`Unsafe inline script content: ${name}`);
  const start = `<!-- BEGIN GENERATED ${name} -->`, end = `<!-- END GENERATED ${name} -->`;
  const block = `${start}\n<script>\n${source}\n</script>\n${end}`;
  const first = html.indexOf(start), last = html.indexOf(end);
  if (first < 0 || last < first) {
    if (check) throw new Error(`Missing embedded source: ${name}`);
    const main = html.indexOf("<script>\n(()=>{'use strict';");
    if (main < 0) throw new Error('Cannot find original game script');
    html = html.slice(0, main) + block + '\n' + html.slice(main);
  } else {
    if (check && html.slice(first, last + end.length) !== block) throw new Error(`Run npm run sync:inline for ${name}`);
    html = html.slice(0, first) + block + html.slice(last + end.length);
  }
}
if (!check) fs.writeFileSync(file, html);
console.log(check ? 'Embedded scripts match their source files.' : 'Embedded scripts updated; index.html remains standalone.');
