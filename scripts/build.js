// Inlines engine.js and data/eks-instances.json into src/index.template.html -> index.html (single file, no fetch).
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const tpl = fs.readFileSync(path.join(root, 'src', 'index.template.html'), 'utf8');
const engine = fs.readFileSync(path.join(root, 'engine.js'), 'utf8');
const data = fs.readFileSync(path.join(root, 'data', 'eks-instances.json'), 'utf8');
const meta = JSON.parse(data).meta;
let out = tpl
  .replace('/*__ENGINE__*/', () => engine)
  .replace('/*__EKS_DATA__*/', () => data.replace(/<\//g, '<\/'))
  .replace(/__EKS_DATA_COMMIT__/g, meta.commit)
  .replace(/__EKS_DATA_DATE__/g, meta.commitDate)
  .replace(/__EKS_DATA_COUNT__/g, String(meta.count));
fs.writeFileSync(path.join(root, 'index.html'), out);
console.log('index.html', fs.statSync(path.join(root, 'index.html')).size, 'bytes; EKS data', meta.count, 'types @', meta.commit, meta.commitDate);
