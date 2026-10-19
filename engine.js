/*
 * Kubernetes IP and node-sizing engine for EKS, GKE and AKS.
 * Pure functions, no DOM. Works in Node (module.exports) and in the browser (window.K8sIP).
 *
 * Every rule carries the official source it came from (see RULES below). Numbers that come from a
 * provider table (EKS instance ENI/IP limits) are loaded from data/eks-instances.json, which is
 * generated from awslabs/amazon-eks-ami nodeadm/internal/kubelet/instance-info.jsonl.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.K8sIP = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- sources
  const RULES = {
    eksMaxPodsFormula: { text: 'maxPods = ENIs x (IPs per ENI - 1) + 2', url: 'https://docs.aws.amazon.com/eks/latest/userguide/choosing-instance-type.html' },
    eksManagedCap: { text: 'Managed node groups cap maxPods at 110 (< 30 vCPU) or 250 (> 30 vCPU)', url: 'https://docs.aws.amazon.com/eks/latest/userguide/choosing-instance-type.html' },
    eksPrefix: { text: 'Prefix delegation assigns /28 (16 address) prefixes to ENI slots', url: 'https://docs.aws.amazon.com/eks/latest/best-practices/prefix-mode-linux.html' },
    eksWarmEni: { text: 'WARM_ENI_TARGET default 1: the CNI keeps one spare ENI with all its IPs allocated', url: 'https://github.com/aws/amazon-vpc-cni-k8s/blob/master/README.md' },
    eksWarmPrefix: { text: 'WARM_PREFIX_TARGET default 1 in the installation manifest', url: 'https://docs.aws.amazon.com/eks/latest/best-practices/prefix-mode-linux.html' },
    eksControlPlane: { text: 'Cluster subnets need at least 6 free IPs each (16 recommended), in at least 2 Availability Zones', url: 'https://docs.aws.amazon.com/eks/latest/userguide/network-reqs.html' },
    eksServiceCidr: { text: 'Service CIDR: inside 10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16; between /24 and /12; must not overlap the VPC', url: 'https://docs.aws.amazon.com/eks/latest/APIReference/API_KubernetesNetworkConfigRequest.html' },
    eksReserved: { text: 'AWS reserves the first four and the last address of every subnet; subnets are /28 to /16', url: 'https://docs.aws.amazon.com/vpc/latest/userguide/subnet-sizing.html' },
    gkeNodeRange: { text: 'Node Pod range M = 31 - ceil(log2(maxPodsPerNode)); 8..256 pods per node, default 110, Autopilot fixed 32', url: 'https://cloud.google.com/kubernetes-engine/docs/how-to/flexible-pod-cidr' },
    gkeNodePoolMin: { text: 'A node pool Pod secondary range must be at least /24', url: 'https://cloud.google.com/kubernetes-engine/docs/how-to/flexible-pod-cidr' },
    gkePrimary: { text: 'Usable primary addresses = 2^(32-S) - 4; smallest primary range /29, largest /9', url: 'https://cloud.google.com/kubernetes-engine/docs/concepts/alias-ips' },
    gkeServices: { text: 'Services: GKE-managed 34.118.224.0/20 by default on new clusters, else a secondary range /24 to /16 (default /20)', url: 'https://cloud.google.com/kubernetes-engine/docs/concepts/alias-ips' },
    aksFormula: { text: 'Azure CNI node subnet: (nodes + surge) + (nodes + surge) x maxPods; default maxPods 30, default surge 1', url: 'https://learn.microsoft.com/en-us/azure/aks/concepts-network-ip-address-planning' },
    aksMaxPods: { text: 'maxPods defaults: Overlay 250, Pod Subnet 110, Azure CNI (legacy) 30, kubenet 110; range 10..250', url: 'https://learn.microsoft.com/en-us/azure/aks/concepts-network-ip-address-planning' },
    aksOverlay: { text: 'Overlay: each node gets a /24 (256 addresses) from the pod CIDR, default 10.244.0.0/16', url: 'https://learn.microsoft.com/en-us/azure/aks/concepts-network-ip-address-planning' },
    aksPodSubnet: { text: 'Pod Subnet: IPs allocated to nodes in batches of 16, next batch when fewer than 8 remain; pod subnets up to /16', url: 'https://learn.microsoft.com/en-us/azure/aks/configure-azure-cni-dynamic-ip-allocation' },
    aksServices: { text: 'Service CIDR default 10.0.0.0/16; must not overlap the VNet', url: 'https://learn.microsoft.com/en-us/azure/aks/azure-cni-overlay' },
    azureReserved: { text: 'Azure reserves the first four and the last address of every subnet; smallest subnet /29', url: 'https://learn.microsoft.com/en-us/azure/virtual-network/virtual-networks-faq' },
  };

  // ---------------------------------------------------------------- ip helpers
  const log2ceil = n => (n <= 1 ? 0 : Math.ceil(Math.log2(n)));
  const pow2 = p => Math.pow(2, p);
  const ip2n = ip => ip.trim().split('.').reduce((a, o) => a * 256 + (+o), 0);
  const n2ip = n => [24, 16, 8, 0].map(s => Math.floor(n / pow2(s)) % 256).join('.');
  const isIp = s => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(String(s).trim());
  function parseCidr(s) {
    const m = String(s || '').trim().match(/^([\d.]+)\/(\d{1,2})$/);
    if (!m || !isIp(m[1]) || +m[2] > 32) return null;
    const p = +m[2], size = pow2(32 - p), base = Math.floor(ip2n(m[1]) / size) * size;
    return { base, prefix: p, size, cidr: n2ip(base) + '/' + p, aligned: base === ip2n(m[1]) };
  }
  const overlaps = (a, b) => a.base < b.base + b.size && b.base < a.base + a.size;
  const within = (inner, outer) => inner.base >= outer.base && inner.base + inner.size <= outer.base + outer.size;
  // smallest prefix whose usable count (size - reserved) covers `need`, clamped to [minPrefix, maxPrefix] (numerically)
  function prefixFor(need, reserved, smallestPrefix, largestPrefix) {
    let p = smallestPrefix; // e.g. 28 (smallest allowed subnet)
    while (p > largestPrefix && pow2(32 - p) - reserved < need) p--;
    const usable = pow2(32 - p) - reserved;
    return { prefix: p, size: pow2(32 - p), usable, fits: usable >= need };
  }

  // ---------------------------------------------------------------- EKS
  let EKS_DATA = null; // { meta, instances: { type: [enis, ips, vcpus, memMib] } }
  function loadEks(data) { EKS_DATA = data; return EKS_DATA; }
  function eksInstance(type) {
    if (!EKS_DATA) throw new Error('EKS instance data not loaded; call loadEks(json) first');
    const r = EKS_DATA.instances[String(type || '').trim().toLowerCase()];
    if (!r) return null;
    return { type: String(type).trim().toLowerCase(), enis: r[0], ipsPerEni: r[1], vcpus: r[2], memMib: r[3] };
  }
  function eksInstanceTypes() { return EKS_DATA ? Object.keys(EKS_DATA.instances) : []; }
  const eksCap = vcpus => (vcpus < 30 ? 110 : 250);

  // maxPods for an instance in secondary-IP or prefix mode, with the managed-node-group cap
  function eksMaxPods(type, o) {
    o = o || {};
    const i = typeof type === 'string' ? eksInstance(type) : type;
    if (!i) return null;
    const slots = i.enis * (i.ipsPerEni - 1);
    const eniFormula = slots + 2;
    const prefixFormula = slots * 16 + 2;
    const cap = eksCap(i.vcpus);
    const managed = o.managed !== false;
    let maxPods, rule;
    if (o.prefixDelegation) { maxPods = Math.min(prefixFormula, cap); rule = maxPods === cap ? 'cap' : 'prefix'; }
    else if (managed) { maxPods = Math.min(eniFormula, cap); rule = maxPods === cap && eniFormula > cap ? 'cap' : 'eni'; }
    else { maxPods = eniFormula; rule = 'eni'; }
    return { instance: i, eniFormula, prefixFormula, cap, managed, prefixDelegation: !!o.prefixDelegation, maxPods, rule };
  }

  // VPC addresses one node takes from its subnet when it runs `pods` pods
  function eksPerNodeIps(type, o) {
    o = o || {};
    const i = typeof type === 'string' ? eksInstance(type) : type;
    if (!i) return null;
    const mp = eksMaxPods(i, o);
    const pods = Math.min(o.pods == null ? mp.maxPods : o.pods, mp.maxPods);
    const slotsPerEni = i.ipsPerEni - 1;
    if (o.prefixDelegation) {
      const warm = o.warmPrefixTarget == null ? 1 : o.warmPrefixTarget;
      const prefixesNeeded = Math.max(1, Math.ceil(pods / 16));
      const prefixes = Math.min(prefixesNeeded + warm, i.enis * slotsPerEni);
      const enisUsed = Math.max(1, Math.ceil(prefixes / slotsPerEni));
      const ips = prefixes * 16 + enisUsed; // one primary IP per attached ENI plus the /28 prefixes
      const worst = i.enis * slotsPerEni * 16 + i.enis;
      return { mode: 'prefix', pods, prefixes, enisUsed, ips, worst, maxPods: mp.maxPods, note: 'prefixes x 16 + one primary IP per ENI; WARM_PREFIX_TARGET ' + warm };
    }
    const warm = o.warmEniTarget == null ? 1 : o.warmEniTarget;
    const enisForPods = Math.max(1, Math.ceil(Math.max(pods - 2, 0) / slotsPerEni));
    const enisUsed = Math.min(i.enis, enisForPods + warm);
    const ips = enisUsed * i.ipsPerEni; // in secondary-IP mode the CNI allocates every address of an attached ENI
    const worst = i.enis * i.ipsPerEni;
    return { mode: 'secondary', pods, enisUsed, ips, worst, maxPods: mp.maxPods, note: 'attached ENIs x IPs per ENI; WARM_ENI_TARGET ' + warm };
  }

  function eksServiceCidrCheck(cidr, vpcCidrs) {
    const c = parseCidr(cidr);
    const items = [];
    if (!c) return { ok: false, items: [{ k: 'bad', t: 'not a CIDR', d: String(cidr) }] };
    const rfc = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'].map(parseCidr);
    if (!rfc.some(r => within(c, r))) items.push({ k: 'bad', t: 'outside the private ranges', d: 'EKS requires the service CIDR inside 10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16.' });
    if (c.prefix < 12 || c.prefix > 24) items.push({ k: 'bad', t: 'prefix /' + c.prefix + ' not allowed', d: 'The service CIDR must be between /24 and /12.' });
    for (const v of (vpcCidrs || []).map(parseCidr).filter(Boolean)) {
      if (overlaps(c, v)) items.push({ k: 'bad', t: 'overlaps ' + v.cidr, d: 'The service CIDR must not overlap any CIDR of the cluster VPC. Services will shadow those addresses.' });
    }
    if (!c.aligned) items.push({ k: 'warn', t: 'not aligned', d: 'The address is not the first of its block; AWS will reject it. Use ' + c.cidr + '.' });
    return { ok: !items.some(x => x.k === 'bad'), cidr: c.cidr, items };
  }

  // Full EKS plan: subnet per AZ for nodes + pods, with growth and control-plane headroom
  function eksPlan(o) {
    const i = eksInstance(o.type);
    if (!i) return { error: 'unknown instance type ' + o.type };
    const azs = Math.max(1, +o.azs || 2);
    const nodesPerAz = Math.max(1, +o.nodesPerAz || 1);
    const growth = Math.max(0, +o.growthPct || 0) / 100;
    const cp = o.controlPlaneIps == null ? 16 : +o.controlPlaneIps;
    const mp = eksMaxPods(i, o);
    const pods = o.podsPerNode == null || o.podsPerNode === '' ? mp.maxPods : Math.min(+o.podsPerNode, mp.maxPods);
    const per = eksPerNodeIps(i, Object.assign({}, o, { pods }));
    const nodesPlanned = Math.ceil(nodesPerAz * (1 + growth));
    const need = nodesPlanned * per.ips + cp;
    const needWorst = nodesPlanned * per.worst + cp;
    const sub = prefixFor(need, 5, 28, 16);
    const subWorst = prefixFor(needWorst, 5, 28, 16);
    const items = [];
    if (azs < 2) items.push({ k: 'bad', t: 'one Availability Zone', d: 'EKS needs subnets in at least two Availability Zones.', src: 'eksControlPlane' });
    if (!sub.fits) items.push({ k: 'bad', t: 'does not fit a /16', d: need + ' addresses per zone exceed the largest AWS subnet. Split the node group or use prefix delegation.', src: 'eksReserved' });
    if (o.prefixDelegation) items.push({ k: 'info', t: 'prefix delegation needs contiguous /28 blocks', d: 'Prefixes come from free, aligned 16-address blocks. A fragmented subnet makes prefix attachment fail; reserve space with a subnet CIDR reservation or use a fresh subnet.', src: 'eksPrefix' });
    if (!o.prefixDelegation && (+o.podsPerNode || 0) > mp.eniFormula) items.push({ k: 'warn', t: 'pods per node above the ENI limit', d: 'This instance type supports ' + mp.eniFormula + ' pods without prefix delegation. Turn prefix delegation on or pick a bigger type.', src: 'eksMaxPodsFormula' });
    if (mp.rule === 'cap') items.push({ k: 'info', t: 'managed node group cap ' + mp.cap, d: 'Managed node groups cap maxPods at ' + mp.cap + ' for this instance size; the formula alone would allow ' + (o.prefixDelegation ? mp.prefixFormula : mp.eniFormula) + '.', src: 'eksManagedCap' });
    if (!o.prefixDelegation && per.ips > pods * 1.5 && pods >= 10) items.push({ k: 'info', t: 'warm pool is ' + (per.ips - pods) + ' addresses per node', d: 'With WARM_ENI_TARGET 1 each node holds a whole spare ENI. Set WARM_IP_TARGET and MINIMUM_IP_TARGET to shrink it.', src: 'eksWarmEni' });
    const perZoneUsable = sub.usable;
    return {
      cloud: 'eks', instance: i, maxPods: mp, podsPerNode: pods, perNode: per, azs, nodesPerAz, nodesPlanned,
      perZone: { need, needWorst, prefix: sub.prefix, usable: perZoneUsable, prefixWorst: subWorst.prefix },
      totals: { nodes: nodesPlanned * azs, pods: nodesPlanned * azs * pods, addresses: pow2(32 - sub.prefix) * azs },
      items, rules: ['eksMaxPodsFormula', 'eksManagedCap', 'eksControlPlane', 'eksReserved'].concat(o.prefixDelegation ? ['eksPrefix', 'eksWarmPrefix'] : ['eksWarmEni']),
    };
  }

  // ---------------------------------------------------------------- GKE
  function gkeNodeRangePrefix(q) { return 31 - log2ceil(q); } // Q=110 -> /24, 8 -> /28, 256 -> /23
  function gkePlan(o) {
    const autopilot = !!o.autopilot;
    let q = autopilot ? 32 : (+o.podsPerNode || 110);
    const items = [];
    if (!autopilot && (q < 8 || q > 256)) { items.push({ k: 'bad', t: 'pods per node out of range', d: 'GKE Standard accepts 8 to 256 Pods per node.', src: 'gkeNodeRange' }); q = Math.min(256, Math.max(8, q)); }
    const nodes = Math.max(1, +o.nodes || 1);
    const surge = o.surge == null ? 1 : Math.max(0, +o.surge);
    const growth = Math.max(0, +o.growthPct || 0) / 100;
    const nodesPlanned = Math.ceil(nodes * (1 + growth)) + surge;
    const M = gkeNodeRangePrefix(q);
    const HM = 32 - M;
    const podRangePrefix = Math.max(9, 32 - (HM + log2ceil(nodesPlanned)));
    const podPoolPrefix = Math.min(podRangePrefix, 24); // a node pool range cannot be smaller than /24
    const maxNodesInPodRange = pow2(32 - podPoolPrefix - HM);
    const primary = prefixFor(nodesPlanned, 4, 29, 9);
    const servicesManaged = o.servicesManaged !== false;
    const servicesPrefix = servicesManaged ? null : (+o.servicesPrefix || 20);
    if (podRangePrefix > 24) items.push({ k: 'info', t: 'Pod range rounded up to /24', d: 'The arithmetic needs only a /' + podRangePrefix + ' but a node pool Pod range must be at least /24.', src: 'gkeNodePoolMin' });
    if (servicesManaged) items.push({ k: 'info', t: 'Services from the GKE-managed range', d: 'New clusters take Service IPs from 34.118.224.0/20 and need no Services secondary range in your subnet.', src: 'gkeServices' });
    if (q > 110 && !autopilot) items.push({ k: 'warn', t: q + ' Pods per node', d: 'Above the 110 default each node reserves a /' + M + ' (' + pow2(HM) + ' addresses). Check kubelet and node resources before raising density.', src: 'gkeNodeRange' });
    return {
      cloud: 'gke', autopilot, podsPerNode: q, nodes, nodesPlanned, surge,
      perNode: { prefix: M, addresses: pow2(HM) },
      podRange: { prefix: podPoolPrefix, addresses: pow2(32 - podPoolPrefix), maxNodes: maxNodesInPodRange },
      primary: { prefix: primary.prefix, usable: primary.usable, fits: primary.fits },
      services: servicesManaged ? { managed: true, range: '34.118.224.0/20' } : { managed: false, prefix: servicesPrefix, count: pow2(32 - servicesPrefix) },
      totals: { pods: nodesPlanned * q },
      items, rules: ['gkeNodeRange', 'gkeNodePoolMin', 'gkePrimary', 'gkeServices'],
    };
  }

  // ---------------------------------------------------------------- AKS
  const AKS_MODES = {
    overlay: { label: 'Azure CNI Overlay', defaultMaxPods: 250 },
    podsubnet: { label: 'Azure CNI Pod Subnet (dynamic IP allocation)', defaultMaxPods: 110 },
    nodesubnet: { label: 'Azure CNI node subnet (legacy)', defaultMaxPods: 30 },
    kubenet: { label: 'kubenet', defaultMaxPods: 110 },
  };
  function aksPlan(o) {
    const mode = AKS_MODES[o.mode] ? o.mode : 'overlay';
    const m = AKS_MODES[mode];
    const items = [];
    let maxPods = o.maxPods == null || o.maxPods === '' ? m.defaultMaxPods : +o.maxPods;
    if (maxPods < 10 || maxPods > 250) { items.push({ k: 'bad', t: 'maxPods out of range', d: 'AKS accepts 10 to 250 pods per node.', src: 'aksMaxPods' }); maxPods = Math.min(250, Math.max(10, maxPods)); }
    const nodes = Math.max(1, +o.nodes || 1);
    const surge = o.surge == null ? 1 : Math.max(0, +o.surge);
    const growth = Math.max(0, +o.growthPct || 0) / 100;
    const n = Math.ceil(nodes * (1 + growth)) + surge;
    let nodeNeed, podSpace = null;
    if (mode === 'nodesubnet') nodeNeed = n + n * maxPods;
    else nodeNeed = n;
    const nodeSubnet = prefixFor(nodeNeed, 5, 29, 2);
    if (mode === 'overlay' || mode === 'kubenet') {
      const podPrefix = Math.max(8, 32 - (8 + log2ceil(n)));
      podSpace = { kind: mode === 'overlay' ? 'pod CIDR (overlay, not VNet space)' : 'pod CIDR (kubenet, not VNet space)', perNode: 256, prefix: podPrefix, maxNodes: pow2(32 - podPrefix - 8), default: '10.244.0.0/16', defaultMaxNodes: 256 };
      if (n > 256) items.push({ k: 'warn', t: 'default pod CIDR holds 256 nodes', d: 'A /24 per node from 10.244.0.0/16 stops at 256 nodes. Set --pod-cidr to a /' + podPrefix + ' or larger.', src: 'aksOverlay' });
    } else if (mode === 'podsubnet') {
      const perNode = Math.ceil(maxPods / 16) * 16 + 16; // batches of 16, next batch requested when fewer than 8 remain
      const need = n * perNode;
      const ps = prefixFor(need, 5, 29, 16);
      podSpace = { kind: 'pod subnet (VNet space)', perNode, need, prefix: ps.prefix, usable: ps.usable, fits: ps.fits };
      if (!ps.fits) items.push({ k: 'bad', t: 'pod subnet larger than /16', d: 'Dynamic IP allocation supports pod subnets up to /16 (about 65,000 pods). Split across node pools or use static block allocation.', src: 'aksPodSubnet' });
    }
    if (mode === 'nodesubnet') items.push({ k: 'info', t: 'every pod takes a VNet address up front', d: 'Legacy Azure CNI pre-assigns maxPods addresses to each node whether pods run or not: ' + n + ' nodes x (1 + ' + maxPods + ') = ' + nodeNeed + '.', src: 'aksFormula' });
    if (mode === 'kubenet') items.push({ k: 'warn', t: 'kubenet is on the retirement path', d: 'Microsoft recommends Azure CNI Overlay for new clusters; kubenet nodes also need a route table entry per node.', src: 'aksMaxPods' });
    if (maxPods === 10 && nodes < 3) items.push({ k: 'bad', t: 'maxPods 10 needs 3 nodes per pool', d: 'The minimum of 10 is allowed only when each node pool has room for 30 pods.', src: 'aksMaxPods' });
    return {
      cloud: 'aks', mode, modeLabel: m.label, maxPods, nodes, surge, nodesPlanned: n,
      nodeSubnet: { need: nodeNeed, prefix: nodeSubnet.prefix, usable: nodeSubnet.usable, fits: nodeSubnet.fits },
      podSpace, services: { default: '10.0.0.0/16' },
      totals: { pods: n * maxPods },
      items, rules: ['aksFormula', 'aksMaxPods', 'azureReserved'].concat(mode === 'overlay' ? ['aksOverlay'] : mode === 'podsubnet' ? ['aksPodSubnet'] : []),
    };
  }

  function plan(cloud, o) {
    if (cloud === 'eks') return eksPlan(o);
    if (cloud === 'gke') return gkePlan(o);
    if (cloud === 'aks') return aksPlan(o);
    return { error: 'unknown cloud ' + cloud };
  }

  return {
    RULES, AKS_MODES, ip2n, n2ip, parseCidr, overlaps, within, prefixFor, log2ceil,
    loadEks, eksInstance, eksInstanceTypes, eksCap, eksMaxPods, eksPerNodeIps, eksServiceCidrCheck, eksPlan,
    gkeNodeRangePrefix, gkePlan, aksPlan, plan,
  };
}));
