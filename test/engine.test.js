const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const E = require('../engine.js');
E.loadEks(require(path.join(__dirname, '..', 'data', 'eks-instances.json')));

// ---- EKS: the numbers everyone knows (eni-max-pods.txt values)
test('EKS ENI formula reproduces the published max-pods values', () => {
  const cases = { 't3.micro': 4, 't3.small': 11, 't3.medium': 17, 'm5.large': 29, 'm5.xlarge': 58, 'c5.4xlarge': 234, 'm5.8xlarge': 234, 'm6i.32xlarge': 737, 'c7g.medium': 8 };
  for (const [t, v] of Object.entries(cases)) assert.equal(E.eksMaxPods(t, { managed: false }).eniFormula, v, t);
});
test('EKS managed node group cap: 110 under 30 vCPU, 250 above', () => {
  assert.equal(E.eksMaxPods('m5.large').maxPods, 29);            // formula below cap
  assert.equal(E.eksMaxPods('c5.4xlarge').maxPods, 110);         // 16 vCPU, formula 234 -> capped
  assert.equal(E.eksMaxPods('c5.4xlarge').rule, 'cap');
  assert.equal(E.eksMaxPods('m5.8xlarge').maxPods, 234);         // 32 vCPU, cap 250 > formula 234
  assert.equal(E.eksMaxPods('m6i.32xlarge').maxPods, 250);       // 128 vCPU, formula 737 -> capped
  assert.equal(E.eksMaxPods('c5.4xlarge', { managed: false }).maxPods, 234);
});
test('EKS prefix delegation: formula x16, then the cap binds', () => {
  const m = E.eksMaxPods('m5.large', { prefixDelegation: true });
  assert.equal(m.prefixFormula, 3 * 9 * 16 + 2);                  // 434
  assert.equal(m.maxPods, 110);
  assert.equal(E.eksMaxPods('m5.8xlarge', { prefixDelegation: true }).maxPods, 250);
  assert.equal(E.eksMaxPods('t3.micro', { prefixDelegation: true }).prefixFormula, 2 * 1 * 16 + 2); // 34
});
test('EKS per-node VPC addresses in secondary-IP mode', () => {
  // m5.large: 3 ENIs x 10 IPs. 29 pods -> all 3 ENIs attached -> 30 addresses.
  const full = E.eksPerNodeIps('m5.large', { pods: 29 });
  assert.equal(full.ips, 30); assert.equal(full.worst, 30);
  // 5 pods -> 1 ENI for pods + 1 warm ENI = 20 addresses
  const few = E.eksPerNodeIps('m5.large', { pods: 5 });
  assert.equal(few.enisUsed, 2); assert.equal(few.ips, 20);
  // WARM_ENI_TARGET 0 -> only the ENI in use
  assert.equal(E.eksPerNodeIps('m5.large', { pods: 5, warmEniTarget: 0 }).ips, 10);
});
test('EKS per-node VPC addresses in prefix mode', () => {
  // 110 pods -> 7 prefixes + 1 warm = 8 x 16 = 128, on 1 ENI (9 slots) -> +1 primary = 129
  const p = E.eksPerNodeIps('m5.large', { prefixDelegation: true, pods: 110 });
  assert.equal(p.prefixes, 8); assert.equal(p.enisUsed, 1); assert.equal(p.ips, 129);
  assert.equal(E.eksPerNodeIps('m5.large', { prefixDelegation: true, pods: 110, warmPrefixTarget: 0 }).ips, 113);
});
test('EKS plan picks the subnet per zone', () => {
  // 10 m5.large per AZ, 2 AZs, max pods, 16 control-plane IPs: 10 x 30 + 16 = 316 -> /23 (507 usable); /24 (251) too small
  const r = E.eksPlan({ type: 'm5.large', nodesPerAz: 10, azs: 2 });
  assert.equal(r.perZone.need, 316); assert.equal(r.perZone.prefix, 23);
  assert.equal(r.totals.pods, 2 * 10 * 29);
  // one AZ is a hard failure
  assert.ok(E.eksPlan({ type: 'm5.large', nodesPerAz: 1, azs: 1 }).items.some(i => i.k === 'bad'));
  // growth 50% -> 15 nodes
  assert.equal(E.eksPlan({ type: 'm5.large', nodesPerAz: 10, azs: 2, growthPct: 50 }).nodesPlanned, 15);
  assert.ok(E.eksPlan({ type: 'nope.large', nodesPerAz: 1, azs: 2 }).error);
});
test('EKS service CIDR rules', () => {
  assert.ok(E.eksServiceCidrCheck('172.20.0.0/16', ['10.0.0.0/16']).ok);
  assert.ok(!E.eksServiceCidrCheck('10.0.0.0/16', ['10.0.0.0/16']).ok);       // overlaps VPC
  assert.ok(!E.eksServiceCidrCheck('100.64.0.0/16', []).ok);                   // outside RFC1918
  assert.ok(!E.eksServiceCidrCheck('10.100.0.0/25', []).ok);                   // smaller than /24
  assert.ok(!E.eksServiceCidrCheck('10.0.0.0/8', []).ok);                      // larger than /12
});

// ---- GKE: table from "Configure maximum Pods per node"
test('GKE node Pod range per max pods', () => {
  const table = { 8: 28, 9: 27, 16: 27, 17: 26, 32: 26, 33: 25, 64: 25, 65: 24, 110: 24, 128: 24, 129: 23, 256: 23 };
  for (const [q, p] of Object.entries(table)) assert.equal(E.gkeNodeRangePrefix(+q), p, 'Q=' + q);
});
test('GKE 900 nodes x 110 pods needs a /14 Pod range (doc example)', () => {
  const r = E.gkePlan({ nodes: 900, podsPerNode: 110, surge: 0 });
  assert.equal(r.perNode.prefix, 24); assert.equal(r.podRange.prefix, 14);
  assert.equal(r.podRange.maxNodes, 1024);
});
test('GKE primary range: 252 nodes fit a /24, 253 need a /23; node pool Pod range floor is /24', () => {
  assert.equal(E.gkePlan({ nodes: 252, surge: 0 }).primary.prefix, 24);
  assert.equal(E.gkePlan({ nodes: 253, surge: 0 }).primary.prefix, 23);
  const small = E.gkePlan({ nodes: 2, podsPerNode: 8, surge: 0 });   // arithmetic says /27, floor /24
  assert.equal(small.podRange.prefix, 24);
  assert.ok(small.items.some(i => i.t.includes('/24')));
});
test('GKE Autopilot fixes 32 pods per node', () => {
  const r = E.gkePlan({ nodes: 10, podsPerNode: 110, autopilot: true });
  assert.equal(r.podsPerNode, 32); assert.equal(r.perNode.prefix, 26);
});

// ---- AKS: worked examples from the IP planning page
test('AKS legacy Azure CNI: 50 nodes, 30 pods, surge 1 -> 1,581 addresses -> /21', () => {
  const r = E.aksPlan({ mode: 'nodesubnet', nodes: 50, maxPods: 30, surge: 1 });
  assert.equal(r.nodeSubnet.need, 1581); assert.equal(r.nodeSubnet.prefix, 21);
  const r2 = E.aksPlan({ mode: 'nodesubnet', nodes: 60, maxPods: 30, surge: 1 });
  assert.equal(r2.nodeSubnet.need, 1891); assert.equal(r2.nodeSubnet.prefix, 21);
});
test('AKS overlay: nodes only in the VNet, a /24 per node from the pod CIDR', () => {
  const r = E.aksPlan({ mode: 'overlay', nodes: 50, surge: 1 });
  assert.equal(r.maxPods, 250); assert.equal(r.nodeSubnet.need, 51); assert.equal(r.nodeSubnet.prefix, 26); // 59 usable
  assert.equal(r.podSpace.prefix, 18); assert.equal(r.podSpace.maxNodes, 64); assert.equal(r.podSpace.defaultMaxNodes, 256); // 51 nodes x /24 fit a /18; the default /16 holds 256
  assert.ok(E.aksPlan({ mode: 'overlay', nodes: 300 }).items.some(i => i.t.includes('256 nodes')));
});
test('AKS pod subnet: batches of 16 per node', () => {
  const r = E.aksPlan({ mode: 'podsubnet', nodes: 10, maxPods: 110, surge: 1 });
  assert.equal(r.podSpace.perNode, 112 + 16);
  assert.equal(r.podSpace.need, 11 * 128);
  assert.equal(r.podSpace.prefix, 21);  // 1408 > 1019 (/22) -> /21
});
test('AKS maxPods bounds', () => {
  assert.ok(E.aksPlan({ mode: 'overlay', nodes: 3, maxPods: 300 }).items.some(i => i.k === 'bad'));
  assert.ok(E.aksPlan({ mode: 'overlay', nodes: 2, maxPods: 10 }).items.some(i => i.t.includes('3 nodes')));
});

// ---- helpers
test('prefixFor respects reserved addresses and bounds', () => {
  assert.equal(E.prefixFor(251, 5, 28, 16).prefix, 24);
  assert.equal(E.prefixFor(252, 5, 28, 16).prefix, 23);
  assert.equal(E.prefixFor(1, 5, 28, 16).prefix, 28);
  assert.equal(E.prefixFor(1e9, 5, 28, 16).fits, false);
});
