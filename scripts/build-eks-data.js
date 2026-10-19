// Builds data/eks-instances.json from the upstream instance-info.jsonl (awslabs/amazon-eks-ami).
// Usage: node scripts/build-eks-data.js <path-to-instance-info.jsonl> <commit> <commit-date>
const fs = require('fs');
const [,, src, commit, date] = process.argv;
const lines = fs.readFileSync(src, 'utf8').split('\n').filter(Boolean);
const rows = lines.map(l => JSON.parse(l));
const bad = rows.filter(r => !r.instanceType || !r.defaultMaxENIs || !r.ipv4AddressesPerInterface || !r.vcpus);
const families = {};
const out = {};
for (const r of rows) {
  out[r.instanceType] = [r.defaultMaxENIs, r.ipv4AddressesPerInterface, r.vcpus, r.physicalMemoryMib];
  const fam = r.instanceType.split('.')[0]; families[fam] = (families[fam] || 0) + 1;
}
const meta = {
  source: 'https://github.com/awslabs/amazon-eks-ami/blob/main/nodeadm/internal/kubelet/instance-info.jsonl',
  commit, commitDate: date, generated: new Date().toISOString().slice(0, 10),
  fields: ['defaultMaxENIs', 'ipv4AddressesPerInterface', 'vcpus', 'physicalMemoryMib'],
  count: rows.length,
};
fs.writeFileSync('data/eks-instances.json', JSON.stringify({ meta, instances: out }));
console.log('instances', rows.length, 'families', Object.keys(families).length, 'incomplete rows', bad.length, bad.slice(0, 5).map(b => b.instanceType).join(','));
console.log('bytes', fs.statSync('data/eks-instances.json').size);
for (const t of ['t3.medium', 'm5.large', 'm5.xlarge', 'm5.2xlarge', 'c5.4xlarge', 'm5.8xlarge', 'm6i.32xlarge', 'r5.24xlarge', 't3.micro', 'c7g.medium']) console.log(t, JSON.stringify(out[t]));
