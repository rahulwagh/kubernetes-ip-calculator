/*
 * Kubernetes IP and node-sizing engine for EKS, GKE, AKS and on-premises distributions (kubeadm, MKE, RKE2, OpenShift, Tanzu, Talos).
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
    eksCustom: { text: 'Custom networking: Pods use secondary ENIs in the ENIConfig subnet; the primary ENI serves no Pods, so max pods = (ENIs - 1) x (IPs per ENI - 1) + 2 (m5.large: 20)', url: 'https://docs.aws.amazon.com/eks/latest/best-practices/custom-networking.html' },
    eksCustomSetup: { text: 'Custom networking setup: one ENIConfig per Availability Zone, AWS_VPC_K8S_CNI_CUSTOM_NETWORK_CFG=true, ENI_CONFIG_LABEL_DEF=topology.kubernetes.io/zone, new nodes only; with your own AMI set maxPods yourself', url: 'https://docs.aws.amazon.com/eks/latest/userguide/cni-custom-network-tutorial.html' },
    vpcCidrQuota: { text: 'IPv4 CIDR blocks per VPC: 5 by default (adjustable to 50), the primary block included; secondary blocks /16 to /28, 100.64.0.0/10 allowed', url: 'https://docs.aws.amazon.com/vpc/latest/userguide/amazon-vpc-limits.html' },
    eksWindows: { text: 'Windows nodes use a single ENI: available Pod addresses = IPs per interface - 1, or (IPs per interface - 1) x 16 with prefix delegation; kubelet max-pods defaults to 110', url: 'https://docs.aws.amazon.com/eks/latest/userguide/windows-support.html' },
    eksWindowsPrefix: { text: 'Windows IPAM warm pool defaults: warm-ip-target 1, minimum-ip-target 3; prefixes need contiguous /28 blocks', url: 'https://docs.aws.amazon.com/eks/latest/best-practices/prefix-mode-win.html' },
    eksIpv6: { text: 'IPv6 clusters: Nitro nodes, prefix delegation required, each node gets a /80 IPv6 prefix and one IPv4 address; Pods and Services are IPv6 only; no custom networking; subnets need an IPv6 /64 from the VPC /56', url: 'https://docs.aws.amazon.com/eks/latest/userguide/cni-ipv6.html' },
    eksIpv6Pods: { text: 'IPv6 max pods = (ENIs x (slots per ENI - 1) x 16) + 2, then the managed node group cap; the limit becomes CPU and memory, not addresses', url: 'https://docs.aws.amazon.com/eks/latest/best-practices/ipv6.html' },
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
    azureReserved: { text: 'Azure reserves the first four and the last address of every subnet; smallest subnet /29', url: 'https://learn.microsoft.com/en-us/azure/virtual-network/virtual-networks-faq' },    k8sNodeCidr: { text: 'kube-controller-manager --node-cidr-mask-size: default 24 for IPv4 (64 for IPv6); one pod CIDR per node is allocated from --cluster-cidr', url: 'https://kubernetes.io/docs/reference/command-line-tools-reference/kube-controller-manager/' },
    k8sMaxPods: { text: 'kubelet maxPods default 110; podsPerCore default 0 (no per-core limit)', url: 'https://kubernetes.io/docs/reference/config-api/kubelet-config.v1beta1/' },
    k8sKubeadm: { text: 'kubeadm --service-cidr default 10.96.0.0/12; --pod-network-cidr makes the control plane allocate a CIDR for every node', url: 'https://kubernetes.io/docs/reference/setup-tools/kubeadm/kubeadm-init/' },
    flannelSubnet: { text: 'Flannel SubnetLen default 24 (two less than the Network prefix when the Network is smaller than /22); kube-flannel.yml uses Network 10.244.0.0/16', url: 'https://github.com/flannel-io/flannel/blob/master/Documentation/configuration.md' },
    calicoBlock: { text: 'Calico IPPool blockSize default 26 (64 addresses), 20 to 32, fixed when the pool is created; a host that fills its block gets another, then borrows addresses from other hosts', url: 'https://docs.tigera.io/calico/latest/reference/resources/ippool' },
    ciliumPool: { text: 'Cilium cluster-pool IPAM: default pod CIDR 10.0.0.0/8, mask size per node 24 (immutable), 2 addresses per block reserved, minimum mask /30', url: 'https://docs.cilium.io/en/stable/network/concepts/ipam/cluster-pool/' },
    rke2Defaults: { text: 'RKE2 defaults: cluster-cidr 10.42.0.0/16, service-cidr 10.43.0.0/16, cni canal; k3s uses the same ranges with Flannel VXLAN', url: 'https://docs.rke2.io/reference/server_config' },
    ocpNetwork: { text: 'OpenShift defaults: clusterNetwork 10.128.0.0/14 with hostPrefix 23 (510 pod IPs per node, 2^(32-23) - 2), serviceNetwork 172.30.0.0/16, machineNetwork 10.0.0.0/16; after installation the cluster network can only be widened and hostPrefix cannot change', url: 'https://docs.okd.io/4.19/networking/networking_operators/cluster-network-operator.html' },
    ocpMaxPods: { text: 'OpenShift KubeletConfig: podsPerCore and maxPods both apply and the lower one wins; the documented example sets podsPerCore 10 and maxPods 250', url: 'https://docs.okd.io/4.19/nodes/nodes/nodes-nodes-managing-max-pods.html' },
    mkeDefaults: { text: 'Mirantis Kubernetes Engine: pod-cidr 192.168.0.0/16 (Calico), service-cluster-ip-range 10.96.0.0/16 (minimum /24), a static IPv4 address per node', url: 'https://docs.mirantis.com/mke/3.8/install/predeployment/configure-networking/ip-considerations.html' },
    tkgDefaults: { text: 'Tanzu Kubernetes Grid: CLUSTER_CIDR 100.96.0.0/11, SERVICE_CIDR 100.64.0.0/13, CNI antrea by default', url: 'https://techdocs.broadcom.com/us/en/vmware-tanzu/standalone-components/tanzu-kubernetes-grid/2-5/tkg/config-ref.html' },
    talosDefaults: { text: 'Talos Linux: KubeNetworkConfig podSubnets 10.244.0.0/16, serviceSubnets 10.96.0.0/12, nodeCIDRMaskSizeIPv4 24; Flannel with VXLAN is the default CNI', url: 'https://docs.siderolabs.com/talos/v1.14/reference/configuration/kubernetes/kubenetworkconfig' },
    metallb: { text: 'MetalLB IPAddressPool: a CIDR or a range of addresses, in the node network for layer 2 mode, advertised through an L2Advertisement', url: 'https://metallb.io/configuration/' },
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
    const custom = !!o.customNetworking;
    const windows = o.os === 'windows';
    const ipv6 = o.ipFamily === 'ipv6';
    const podEnis = windows ? 1 : (custom ? Math.max(0, i.enis - 1) : i.enis); // Windows: one ENI; custom networking: primary ENI serves no Pods
    const slots = podEnis * (i.ipsPerEni - 1);
    const eniFormula = windows ? slots : slots + 2;          // Windows: no +2, the limit is addresses on the single ENI
    const prefixFormula = windows ? slots * 16 : slots * 16 + 2;
    const cap = eksCap(i.vcpus);
    const managed = o.managed !== false;
    let maxPods, rule;
    if (windows) {
      const addr = o.prefixDelegation ? prefixFormula : eniFormula;
      maxPods = Math.min(addr, 110); rule = maxPods === 110 && addr > 110 ? 'kubelet-default' : (o.prefixDelegation ? 'prefix' : 'eni');
      return { instance: i, eniFormula, prefixFormula, cap: 110, managed, prefixDelegation: !!o.prefixDelegation, customNetworking: false, windows: true, ipv6: false, podEnis, maxPods, rule };
    }
    if (ipv6) {
      maxPods = Math.min(prefixFormula, cap); rule = maxPods === cap ? 'cap' : 'prefix';
      return { instance: i, eniFormula, prefixFormula, cap, managed, prefixDelegation: true, customNetworking: false, windows: false, ipv6: true, podEnis, maxPods, rule };
    }
    if (o.prefixDelegation) { maxPods = Math.min(prefixFormula, cap); rule = maxPods === cap ? 'cap' : 'prefix'; }
    else if (managed) { maxPods = Math.min(eniFormula, cap); rule = maxPods === cap && eniFormula > cap ? 'cap' : 'eni'; }
    else { maxPods = eniFormula; rule = 'eni'; }
    return { instance: i, eniFormula, prefixFormula, cap, managed, prefixDelegation: !!o.prefixDelegation, customNetworking: custom, windows: false, ipv6: false, podEnis, maxPods, rule };
  }

  // VPC addresses one node takes from its subnet when it runs `pods` pods
  function eksPerNodeIps(type, o) {
    o = o || {};
    const i = typeof type === 'string' ? eksInstance(type) : type;
    if (!i) return null;
    const mp = eksMaxPods(i, o);
    const pods = Math.min(o.pods == null ? mp.maxPods : o.pods, mp.maxPods);
    const slotsPerEni = i.ipsPerEni - 1;
    if (mp.ipv6) {
      // IPv6: the node takes one IPv4 address from the dual-stack subnet; Pods live in the node's /80 IPv6 prefix
      return { mode: 'ipv6', pods, enisUsed: 1, nodeIps: 1, podIps: 0, ips: 1, worst: 1, maxPods: mp.maxPods, ipv6PrefixPerNode: 80, note: 'one IPv4 per node; Pods use the /80 IPv6 prefix' };
    }
    if (mp.windows) {
      // Windows IPAM (VPC resource controller) on the single ENI: warm-ip-target 1, minimum-ip-target 3
      if (o.prefixDelegation) {
        const warm = o.warmPrefixTarget == null ? 1 : o.warmPrefixTarget;
        const prefixes = Math.min(Math.max(1, Math.ceil(pods / 16)) + Math.max(0, warm - 1) + (pods % 16 === 0 ? 1 : 0) * 0, slotsPerEni);
        const ips = 1 + prefixes * 16;
        return { mode: 'windows-prefix', windows: true, pods, prefixes, enisUsed: 1, ips, worst: 1 + slotsPerEni * 16, maxPods: mp.maxPods, note: 'single ENI: primary + prefixes x 16' };
      }
      const warm = o.warmIpTarget == null ? 1 : o.warmIpTarget;
      const ips = 1 + Math.min(slotsPerEni, Math.max(pods + warm, 3));
      return { mode: 'windows', windows: true, pods, enisUsed: 1, ips, worst: i.ipsPerEni, maxPods: mp.maxPods, note: 'single ENI: primary + pods + warm-ip-target ' + warm + ' (minimum-ip-target 3)' };
    }
    if (o.customNetworking) {
      // node subnet keeps only the primary ENI's own address; every Pod ENI and its addresses live in the ENIConfig (pod) subnet
      const podEnis = mp.podEnis;
      if (podEnis === 0) return { mode: 'custom', custom: true, pods: 0, enisUsed: 0, nodeIps: 1, podIps: 0, ips: 1, worst: 1, podWorst: 0, maxPods: mp.maxPods, note: 'one ENI only: custom networking leaves no ENI for Pods' };
      if (o.prefixDelegation) {
        const warm = o.warmPrefixTarget == null ? 1 : o.warmPrefixTarget;
        const prefixes = Math.min(Math.max(1, Math.ceil(pods / 16)) + warm, podEnis * slotsPerEni);
        const enisUsed = Math.max(1, Math.ceil(prefixes / slotsPerEni));
        const podIps = prefixes * 16 + enisUsed;
        const podWorst = podEnis * slotsPerEni * 16 + podEnis;
        return { mode: 'custom-prefix', custom: true, pods, prefixes, enisUsed, nodeIps: 1, podIps, ips: 1 + podIps, worst: 1 + podWorst, podWorst, maxPods: mp.maxPods, note: 'pod subnet: prefixes x 16 + one address per Pod ENI; node subnet: 1' };
      }
      const warm = o.warmEniTarget == null ? 1 : o.warmEniTarget;
      const enisForPods = Math.max(1, Math.ceil(Math.max(pods - 2, 0) / slotsPerEni));
      const enisUsed = Math.min(podEnis, enisForPods + warm);
      const podIps = enisUsed * i.ipsPerEni;
      const podWorst = podEnis * i.ipsPerEni;
      return { mode: 'custom', custom: true, pods, enisUsed, nodeIps: 1, podIps, ips: 1 + podIps, worst: 1 + podWorst, podWorst, maxPods: mp.maxPods, note: 'pod subnet: Pod ENIs x IPs per ENI; node subnet: 1; WARM_ENI_TARGET ' + warm };
    }
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
    if (mp.ipv6) return eksPlanIpv6(o, i, azs, nodesPerAz, nodesPlanned, cp, mp, pods, per);
    if (mp.windows) { /* falls through to the standard subnet sizing with Windows per-node numbers */ }
    else if (o.customNetworking) return eksPlanCustom(o, i, azs, nodesPerAz, nodesPlanned, cp, mp, pods, per);
    const need = nodesPlanned * per.ips + cp;
    const needWorst = nodesPlanned * per.worst + cp;
    const sub = prefixFor(need, 5, 28, 16);
    const subWorst = prefixFor(needWorst, 5, 28, 16);
    const items = [];
    if (azs < 2) items.push({ k: 'bad', t: 'one Availability Zone', d: 'EKS needs subnets in at least two Availability Zones.', src: 'eksControlPlane' });
    if (!sub.fits) items.push({ k: 'bad', t: 'does not fit a /16', d: need + ' addresses per zone exceed the largest AWS subnet. Split the node group or use prefix delegation.', src: 'eksReserved' });
    if (mp.windows) {
      items.push({ k: 'info', t: 'Windows: one ENI per node', d: i.type + ' keeps only its primary ENI on Windows, so Pod addresses are ' + (o.prefixDelegation ? '(' + i.ipsPerEni + ' - 1) x 16 = ' + mp.prefixFormula : i.ipsPerEni + ' - 1 = ' + mp.eniFormula) + '; kubelet max-pods defaults to 110.', src: 'eksWindows' });
      if (!o.prefixDelegation && mp.eniFormula < 30) items.push({ k: 'warn', t: 'only ' + mp.eniFormula + ' Pods per Windows node', d: 'Turn on Windows prefix delegation (enable-windows-prefix-delegation in the amazon-vpc-cni config map) or pick a type with more IPs per ENI.', src: 'eksWindowsPrefix' });
    }
    if (o.prefixDelegation) items.push({ k: 'info', t: 'prefix delegation needs contiguous /28 blocks', d: 'Prefixes come from free, aligned 16-address blocks. A fragmented subnet makes prefix attachment fail; reserve space with a subnet CIDR reservation or use a fresh subnet.', src: 'eksPrefix' });
    if (!o.prefixDelegation && (+o.podsPerNode || 0) > mp.eniFormula) items.push({ k: 'warn', t: 'pods per node above the ENI limit', d: 'This instance type supports ' + mp.eniFormula + ' pods without prefix delegation. Turn prefix delegation on or pick a bigger type.', src: 'eksMaxPodsFormula' });
    if (mp.rule === 'cap') items.push({ k: 'info', t: 'managed node group cap ' + mp.cap, d: 'Managed node groups cap maxPods at ' + mp.cap + ' for this instance size; the formula alone would allow ' + (o.prefixDelegation ? mp.prefixFormula : mp.eniFormula) + '.', src: 'eksManagedCap' });
    if (!o.prefixDelegation && per.ips > pods * 1.5 && pods >= 10) items.push({ k: 'info', t: 'warm pool is ' + (per.ips - pods) + ' addresses per node', d: 'With WARM_ENI_TARGET 1 each node holds a whole spare ENI. Set WARM_IP_TARGET and MINIMUM_IP_TARGET to shrink it.', src: 'eksWarmEni' });
    const perZoneUsable = sub.usable;
    return {
      cloud: 'eks', windows: !!mp.windows, instance: i, maxPods: mp, podsPerNode: pods, perNode: per, azs, nodesPerAz, nodesPlanned,
      perZone: { need, needWorst, prefix: sub.prefix, usable: perZoneUsable, prefixWorst: subWorst.prefix },
      totals: { nodes: nodesPlanned * azs, pods: nodesPlanned * azs * pods, addresses: pow2(32 - sub.prefix) * azs },
      items, rules: (mp.windows ? ['eksWindows', 'eksWindowsPrefix'] : ['eksMaxPodsFormula']).concat(['eksManagedCap', 'eksControlPlane', 'eksReserved']).concat(o.prefixDelegation && !mp.windows ? ['eksPrefix', 'eksWarmPrefix'] : mp.windows ? [] : ['eksWarmEni']),
    };
  }

  // IPv6 cluster: IPv4 subnet holds one address per node plus the control plane; Pods come from the node's /80 inside the subnet's /64
  function eksPlanIpv6(o, i, azs, nodesPerAz, nodesPlanned, cp, mp, pods, per) {
    const items = [];
    const need = nodesPlanned * 1 + cp;
    const sub = prefixFor(need, 5, 28, 16);
    if (azs < 2) items.push({ k: 'bad', t: 'one Availability Zone', d: 'EKS needs subnets in at least two Availability Zones.', src: 'eksControlPlane' });
    if (i.vcpus < 2 && /^(t2|m1|m3|c1|c3|m2|r3|i2|g2)\./.test(i.type)) items.push({ k: 'bad', t: i.type + ' is not Nitro', d: 'IPv6 clusters need Nitro-based instances because prefix delegation is required.', src: 'eksIpv6' });
    items.push({ k: 'info', t: 'Pods are IPv6 only; the IPv4 subnet holds nodes, not Pods', d: 'Each node takes one IPv4 address from the dual-stack subnet and a /80 IPv6 prefix for its Pods (about 10^14 addresses). A /64 per subnet holds 65,536 node prefixes.', src: 'eksIpv6' });
    items.push({ k: 'info', t: 'max pods ' + mp.maxPods + ' comes from the prefix formula and the cap', d: 'IPv6 removes the address limit; (' + i.enis + ' x (' + i.ipsPerEni + ' - 1) x 16) + 2 = ' + fmtNum(mp.prefixFormula) + (mp.rule === 'cap' ? ', capped at ' + mp.cap + ' by the managed node group' : '') + '. Size nodes by CPU and memory.', src: 'eksIpv6Pods' });
    items.push({ k: 'warn', t: 'creation-time choice, no custom networking, IPv6-only Services', d: 'The IP family is set when the cluster is created and cannot be changed. Custom networking is not supported. Pods reach IPv4-only endpoints through NAT on the node; Services get ULA IPv6 addresses.', src: 'eksIpv6' });
    if (o.customNetworking) items.push({ k: 'bad', t: 'custom networking is not available with IPv6', d: 'Turn one of the two off. IPv6 is the replacement for custom networking as the exhaustion fix.', src: 'eksIpv6' });
    return {
      cloud: 'eks', ipv6: true, instance: i, maxPods: mp, podsPerNode: pods, perNode: per, azs, nodesPerAz, nodesPlanned,
      perZone: { need, needWorst: need, prefix: sub.prefix, usable: sub.usable, prefixWorst: sub.prefix },
      ipv6Plan: { vpc: 56, subnet: 64, node: 80, nodesPerSubnet: Math.pow(2, 16) },
      totals: { nodes: nodesPlanned * azs, pods: nodesPlanned * azs * pods, addresses: pow2(32 - sub.prefix) * azs },
      items, rules: ['eksIpv6', 'eksIpv6Pods', 'eksManagedCap', 'eksControlPlane', 'eksReserved'],
    };
  }
  function fmtNum(n) { return Number(n).toLocaleString('en-US'); }

  // Custom networking: nodes stay in the node subnet (one address each), Pods move to a per-zone subnet carved from a secondary CIDR
  function eksPlanCustom(o, i, azs, nodesPerAz, nodesPlanned, cp, mp, pods, per) {
    const items = [];
    const nodeNeed = nodesPlanned * per.nodeIps + cp;
    const podNeed = nodesPlanned * per.podIps;
    const podNeedWorst = nodesPlanned * per.podWorst;
    const nodeSub = prefixFor(nodeNeed, 5, 28, 16);
    const podSub = prefixFor(Math.max(1, podNeed), 5, 28, 16);
    const podSubWorst = prefixFor(Math.max(1, podNeedWorst), 5, 28, 16);
    const secPrefix = podSub.prefix - log2ceil(azs);
    const secondary = { prefix: secPrefix, cidr: '100.64.0.0/' + Math.max(16, secPrefix), fits: secPrefix >= 16 };
    if (azs < 2) items.push({ k: 'bad', t: 'one Availability Zone', d: 'EKS needs subnets in at least two Availability Zones.', src: 'eksControlPlane' });
    if (mp.podEnis === 0) items.push({ k: 'bad', t: i.type + ' has one ENI', d: 'Custom networking takes the primary ENI away from Pods, so this instance type can run only the two host-network Pods. Pick a type with at least two ENIs.', src: 'eksCustom' });
    if (!podSub.fits) items.push({ k: 'bad', t: 'pod subnet larger than a /16', d: podNeed + ' Pod addresses per zone exceed the largest AWS subnet. Split the node group or add prefix delegation.', src: 'eksReserved' });
    else if (!secondary.fits) items.push({ k: 'warn', t: 'pod subnets need more than one /16 secondary block', d: azs + ' pod subnets of /' + podSub.prefix + ' need a /' + secPrefix + ', and a secondary VPC CIDR can be at most a /16. Associate more than one secondary block; a VPC holds 5 IPv4 CIDR blocks by default, the primary included.', src: 'vpcCidrQuota' });
    items.push({ k: 'info', t: 'max pods drops from ' + eksMaxPods(i, Object.assign({}, o, { customNetworking: false })).maxPods + ' to ' + mp.maxPods, d: 'With custom networking the primary ENI serves no Pods, so ' + i.type + ' loses one ENI of Pod capacity: (' + i.enis + ' - 1) x (' + i.ipsPerEni + ' - 1) + 2' + (o.prefixDelegation ? ' slots, x16 with prefixes' : '') + '.', src: 'eksCustom' });
    items.push({ k: 'warn', t: 'check the max pods your nodes advertise', d: 'Compare kubectl get node -o jsonpath="{.items[*].status.allocatable.pods}" with ' + mp.maxPods + '. If a node advertises more, Pods past ' + mp.maxPods + ' wait in ContainerCreating; with your own AMI in a launch template set maxPods to ' + mp.maxPods + ' (the AWS tutorial sets 20 for m5.large).', src: 'eksCustomSetup' });
    items.push({ k: 'info', t: 'one ENIConfig per zone, new nodes only', d: 'Name each ENIConfig after its zone, set AWS_VPC_K8S_CNI_CUSTOM_NETWORK_CFG=true and ENI_CONFIG_LABEL_DEF=topology.kubernetes.io/zone on aws-node, then create a new node group and drain the old one. Existing nodes keep their ENIs.', src: 'eksCustomSetup' });
    items.push({ k: 'info', t: 'take the secondary block from 100.64.0.0/10', d: 'AWS recommends the shared address space for Pod CIDRs because corporate networks rarely use it. Pods reach other networks through the node primary address (SNAT), so the range does not have to be routable.', src: 'eksCustom' });
    if (o.prefixDelegation) items.push({ k: 'info', t: 'prefix delegation needs contiguous /28 blocks', d: 'Prefixes come from free, aligned 16-address blocks of the pod subnet; a fresh secondary-CIDR subnet has them.', src: 'eksPrefix' });
    if (mp.rule === 'cap') items.push({ k: 'info', t: 'managed node group cap ' + mp.cap, d: 'Managed node groups cap maxPods at ' + mp.cap + ' for this instance size; the custom-networking formula alone would allow ' + (o.prefixDelegation ? mp.prefixFormula : mp.eniFormula) + '.', src: 'eksManagedCap' });
    return {
      cloud: 'eks', custom: true, instance: i, maxPods: mp, podsPerNode: pods, perNode: per, azs, nodesPerAz, nodesPlanned,
      perZone: { need: nodeNeed, prefix: nodeSub.prefix, usable: nodeSub.usable, needWorst: nodeNeed, prefixWorst: nodeSub.prefix },
      podZone: { need: podNeed, prefix: podSub.prefix, usable: podSub.usable, fits: podSub.fits, needWorst: podNeedWorst, prefixWorst: podSubWorst.prefix },
      secondary,
      totals: { nodes: nodesPlanned * azs, pods: nodesPlanned * azs * pods, addresses: (pow2(32 - nodeSub.prefix) + pow2(32 - podSub.prefix)) * azs },
      items, rules: ['eksCustom', 'eksCustomSetup', 'vpcCidrQuota', 'eksManagedCap', 'eksControlPlane', 'eksReserved'].concat(o.prefixDelegation ? ['eksPrefix', 'eksWarmPrefix'] : ['eksWarmEni']),
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

  // ---------------------------------------------------------------- on-premises / self-managed
  // The pod network is sized by the CNI, not the vendor: a block per node from the pod CIDR (kube-controller-manager
  // --node-cidr-mask-size, Flannel SubnetLen, Cilium cluster-pool mask, OpenShift hostPrefix) or, with Calico, /26 blocks
  // handed out on demand. The distribution only sets the defaults.
  const ONPREM_CNIS = {
    flannel: { label: 'Flannel', blocks: 'one', mask: 24, src: 'flannelSubnet' },
    calico: { label: 'Calico', blocks: 'many', mask: 26, src: 'calicoBlock' },
    cilium: { label: 'Cilium (cluster-pool IPAM)', blocks: 'one', mask: 24, src: 'ciliumPool' },
    canal: { label: 'Canal (Flannel + Calico policy)', blocks: 'one', mask: 24, src: 'flannelSubnet' },
    ovn: { label: 'OVN-Kubernetes', blocks: 'one', mask: 23, src: 'ocpNetwork' },
    antrea: { label: 'Antrea', blocks: 'one', mask: 24, src: 'k8sNodeCidr' },
  };
  const ONPREM_DISTROS = {
    kubeadm: { label: 'kubeadm (vanilla Kubernetes)', cni: 'flannel', cniChoice: ['flannel', 'calico', 'cilium'], podCidr: '10.244.0.0/16', svcCidr: '10.96.0.0/12', maxPods: 110, src: 'k8sKubeadm' },
    mke: { label: 'Mirantis Kubernetes Engine (MKE)', cni: 'calico', cniChoice: null, podCidr: '192.168.0.0/16', svcCidr: '10.96.0.0/16', maxPods: 110, src: 'mkeDefaults' },
    rke2: { label: 'Rancher RKE2 / k3s', cni: 'canal', cniChoice: ['canal', 'calico', 'cilium', 'flannel'], podCidr: '10.42.0.0/16', svcCidr: '10.43.0.0/16', maxPods: 110, src: 'rke2Defaults' },
    openshift: { label: 'Red Hat OpenShift', cni: 'ovn', cniChoice: null, podCidr: '10.128.0.0/14', svcCidr: '172.30.0.0/16', maxPods: 250, src: 'ocpNetwork' },
    tanzu: { label: 'VMware Tanzu Kubernetes Grid', cni: 'antrea', cniChoice: ['antrea', 'calico'], podCidr: '100.96.0.0/11', svcCidr: '100.64.0.0/13', maxPods: 110, src: 'tkgDefaults' },
    talos: { label: 'Talos Linux', cni: 'flannel', cniChoice: ['flannel', 'cilium', 'calico'], podCidr: '10.244.0.0/16', svcCidr: '10.96.0.0/12', maxPods: 110, src: 'talosDefaults' },
  };
  const ONPREM_VLAN_RESERVED = 3; // network, broadcast and the gateway: a planning assumption, not a Kubernetes rule
  function onpremPlan(o) {
    const d = ONPREM_DISTROS[o.distro] || ONPREM_DISTROS.kubeadm;
    const distro = ONPREM_DISTROS[o.distro] ? o.distro : 'kubeadm';
    const cniKey = d.cniChoice && ONPREM_CNIS[o.cni] && d.cniChoice.indexOf(o.cni) >= 0 ? o.cni : d.cni;
    const cni = ONPREM_CNIS[cniKey];
    const items = [];
    let pod = parseCidr(o.podCidr || d.podCidr);
    if (!pod) { items.push({ k: 'bad', t: 'pod CIDR is not valid', d: 'Type it as address/prefix; using the ' + d.label + ' default ' + d.podCidr + ' meanwhile.' }); pod = parseCidr(d.podCidr); }
    let svc = parseCidr(o.svcCidr || d.svcCidr);
    if (!svc) { items.push({ k: 'bad', t: 'service CIDR is not valid', d: 'Type it as address/prefix; using the default ' + d.svcCidr + ' meanwhile.' }); svc = parseCidr(d.svcCidr); }
    let mask = +o.nodeMask || cni.mask;
    if (mask <= pod.prefix || mask > 30) { items.push({ k: 'bad', t: 'per-node block /' + mask + ' does not fit the pod CIDR', d: 'The block must be smaller than the pod CIDR /' + pod.prefix + ' and no smaller than /30.', src: cni.src }); mask = Math.min(30, Math.max(pod.prefix + 1, cni.mask)); }
    const blockAddr = pow2(32 - mask);
    const blocks = pow2(mask - pod.prefix);
    const maxPods = o.maxPods == null || o.maxPods === '' ? d.maxPods : Math.max(1, +o.maxPods);
    const nodes = Math.max(1, +o.nodes || 1);
    const growth = Math.max(0, +o.growthPct || 0) / 100;
    const nodesPlanned = Math.ceil(nodes * (1 + growth));
    let blocksPerNode = 1, podsPerBlock = blockAddr - 2, effectivePods = maxPods;
    if (cni.blocks === 'many') { blocksPerNode = Math.max(1, Math.ceil(maxPods / blockAddr)); podsPerBlock = blockAddr; }
    else if (maxPods > podsPerBlock) { effectivePods = podsPerBlock; items.push({ k: 'warn', t: 'a /' + mask + ' block holds ' + podsPerBlock + ' pods, maxPods asks for ' + maxPods, d: 'The node CIDR is the hard limit: pods beyond ' + podsPerBlock + ' stay pending without an address. Use a larger block (smaller prefix) or lower maxPods.', src: cni.src }); }
    const capacity = Math.floor(blocks / blocksPerNode);
    const fits = nodesPlanned <= capacity;
    const requiredPrefix = Math.max(8, mask - log2ceil(nodesPlanned * blocksPerNode));
    if (!fits) items.push({ k: 'bad', t: pod.cidr + ' holds ' + fmtNum(capacity) + ' nodes, you plan ' + fmtNum(nodesPlanned), d: 'With ' + blocksPerNode + ' × /' + mask + ' per node the pod CIDR runs out at node ' + fmtNum(capacity + 1) + '. Use a /' + requiredPrefix + ' pod CIDR, or a smaller block per node' + (cni.blocks === 'one' ? ' (which also lowers the pods a node can run)' : '') + '.', src: cni.src });
    else if (nodesPlanned / capacity > 0.75) items.push({ k: 'warn', t: 'pod CIDR ' + Math.round(nodesPlanned / capacity * 100) + '% used at ' + fmtNum(nodesPlanned) + ' nodes', d: fmtNum(capacity - nodesPlanned) + ' node slots left. Most distributions cannot change the pod CIDR after installation (OpenShift can only widen it); size it for the cluster you will have in three years.', src: d.src });
    if (cni.blocks === 'many') items.push({ k: 'info', t: 'Calico hands out /' + mask + ' blocks on demand', d: 'A node that fills its ' + fmtNum(blockAddr) + '-address block gets another one; with maxPods ' + maxPods + ' plan ' + blocksPerNode + ' block' + (blocksPerNode > 1 ? 's' : '') + ' per node. When no blocks are left, nodes borrow single addresses from other nodes’ blocks, which adds host routes. blockSize is fixed when the pool is created.', src: 'calicoBlock' });
    if (cniKey === 'cilium') items.push({ k: 'info', t: 'Cilium reserves 2 addresses per block; the mask cannot change later', d: 'cluster-pool-ipv4-mask-size is immutable; to grow, add another CIDR to clusterPoolIPv4PodCIDRList instead of editing the existing one.', src: 'ciliumPool' });
    if (distro === 'openshift') items.push({ k: 'info', t: 'hostPrefix ' + mask + ' is fixed after installation; the cluster network can only widen', d: 'A hostPrefix of 23 provides 510 pod IPs per node (2^(32-23) - 2). You can expand clusterNetwork later, never change hostPrefix.', src: 'ocpNetwork' });
    if (distro === 'openshift' && maxPods !== 250) items.push({ k: 'info', t: 'OpenShift pods per node: podsPerCore and maxPods both apply', d: 'The KubeletConfig example in the docs sets podsPerCore 10 and maxPods 250; the lower of the two limits a node. You plan ' + maxPods + '.', src: 'ocpMaxPods' });
    if (distro === 'kubeadm' && mask !== 24) items.push({ k: 'info', t: 'set node-cidr-mask-size to ' + mask + ' on kube-controller-manager', d: 'kubeadm defaults to /24 per node. Pass node-cidr-mask-size through controllerManager.extraArgs in ClusterConfiguration (see the Config tab); the CNI must use the same size.', src: 'k8sNodeCidr' });
    if (maxPods !== 110 && distro !== 'openshift') items.push({ k: 'info', t: 'kubelet maxPods default is 110', d: 'You plan ' + maxPods + ' per node. Set maxPods in KubeletConfiguration (kubeadm, Talos) or kubelet-arg max-pods (RKE2, k3s); podsPerCore 0 means no per-core limit.', src: 'k8sMaxPods' });
    // service range
    if (overlaps(pod, svc)) items.push({ k: 'bad', t: 'pod CIDR and service CIDR overlap', d: pod.cidr + ' and ' + svc.cidr + ' share addresses; kube-proxy and the CNI cannot tell a Service from a Pod. Pick disjoint ranges.', src: 'k8sKubeadm' });
    // node network (VLAN): nodes + control-plane VIPs + LoadBalancer pool
    const vips = o.vips == null || o.vips === '' ? 1 : Math.max(0, +o.vips);
    const lbPool = Math.max(0, +o.lbPool || 0);
    const vlanNeed = nodesPlanned + vips + lbPool;
    const vlanSuggest = prefixFor(vlanNeed, ONPREM_VLAN_RESERVED, 29, 8);
    let vlan = { given: false, need: vlanNeed, vips, lbPool, prefix: vlanSuggest.prefix, usable: vlanSuggest.usable, fits: true, reserved: ONPREM_VLAN_RESERVED };
    const nn = o.nodeNet ? parseCidr(o.nodeNet) : null;
    if (o.nodeNet && !nn) items.push({ k: 'warn', t: 'node network CIDR is not valid', d: 'Type the VLAN as address/prefix, for example 10.20.30.0/24. Showing the size you would need instead.' });
    if (nn) {
      const usable = nn.size - ONPREM_VLAN_RESERVED;
      vlan = { given: true, cidr: nn.cidr, need: vlanNeed, vips, lbPool, prefix: nn.prefix, usable, fits: usable >= vlanNeed, reserved: ONPREM_VLAN_RESERVED, suggested: vlanSuggest.prefix };
      if (!vlan.fits) items.push({ k: 'bad', t: 'node network ' + nn.cidr + ' is too small', d: fmtNum(nodesPlanned) + ' nodes + ' + vips + ' VIP' + (vips === 1 ? '' : 's') + ' + ' + fmtNum(lbPool) + ' load-balancer addresses need ' + fmtNum(vlanNeed) + ', the VLAN has ' + fmtNum(usable) + ' usable (' + ONPREM_VLAN_RESERVED + ' reserved for network, broadcast and gateway). A /' + vlanSuggest.prefix + ' would do.', src: 'metallb' });
      if (overlaps(nn, pod)) items.push({ k: 'bad', t: 'node network overlaps the pod CIDR', d: nn.cidr + ' and ' + pod.cidr + ' share addresses. Cilium, Flannel and OVN route pod traffic by these ranges; the overlap breaks node-to-pod traffic. Move the pod CIDR.', src: 'ciliumPool' });
      if (overlaps(nn, svc)) items.push({ k: 'bad', t: 'node network overlaps the service CIDR', d: nn.cidr + ' and ' + svc.cidr + ' share addresses; ClusterIP traffic would be routed to the VLAN. Pick a disjoint service CIDR.', src: 'k8sKubeadm' });
    }
    if (lbPool > 0) items.push({ k: 'info', t: fmtNum(lbPool) + ' LoadBalancer addresses from the node network', d: 'On-premises there is no cloud load balancer: MetalLB (or kube-vip) answers for a pool of VLAN addresses. In layer 2 mode the pool must be in the node network; reserve those addresses in your IPAM so DHCP never hands them out.', src: 'metallb' });
    // corporate ranges to keep clear of
    for (const c of (o.corp || [])) { const cc = parseCidr(c); if (!cc) continue; if (overlaps(cc, pod)) items.push({ k: 'warn', t: 'pod CIDR overlaps ' + cc.cidr, d: 'Pods cannot reach that network: the CNI routes it locally. Pick a pod CIDR your routed networks do not use.', src: 'ciliumPool' }); if (overlaps(cc, svc)) items.push({ k: 'warn', t: 'service CIDR overlaps ' + cc.cidr, d: 'Traffic to that network would be captured by kube-proxy. Pick a service CIDR your routed networks do not use.', src: 'k8sKubeadm' }); }
    const rules = ['k8sNodeCidr', 'k8sMaxPods', d.src, cni.src, 'metallb'].filter((v, i, a) => a.indexOf(v) === i);
    return {
      cloud: 'onprem', distro, distroLabel: d.label, cni: cniKey, cniLabel: cni.label, cniChoice: d.cniChoice, blocksMode: cni.blocks,
      pod: { cidr: pod.cidr, prefix: pod.prefix, size: pod.size }, nodeMask: mask,
      block: { prefix: mask, addresses: blockAddr, perNode: blocksPerNode, podsPerBlock },
      nodes, nodesPlanned, capacity: { nodes: capacity, blocks }, fits, requiredPrefix, maxPods, effectivePods,
      services: { cidr: svc.cidr, prefix: svc.prefix, count: svc.size },
      vlan, totals: { pods: nodesPlanned * effectivePods, blocksUsed: nodesPlanned * blocksPerNode },
      items, rules,
    };
  }

  function plan(cloud, o) {
    if (cloud === 'eks') return eksPlan(o);
    if (cloud === 'gke') return gkePlan(o);
    if (cloud === 'aks') return aksPlan(o);
    if (cloud === 'onprem') return onpremPlan(o);
    return { error: 'unknown cloud ' + cloud };
  }

  return {
    RULES, AKS_MODES, ip2n, n2ip, parseCidr, overlaps, within, prefixFor, log2ceil,
    loadEks, eksInstance, eksInstanceTypes, eksCap, eksMaxPods, eksPerNodeIps, eksServiceCidrCheck, eksPlan,
    gkeNodeRangePrefix, gkePlan, aksPlan, ONPREM_CNIS, ONPREM_DISTROS, onpremPlan, plan,
  };
}));
