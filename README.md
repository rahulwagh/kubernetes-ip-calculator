# Kubernetes IP Calculator

**Live tool: https://jhooq.com/tools/kubernetes-ip-calculator/**

How many IP addresses does your EKS, GKE or AKS cluster really need? Pick the cloud, the instance type or the pods per node, the node count and the zones. You get:

- the maximum pods per node and which rule set it (ENI formula, prefix delegation, managed node group cap),
- the VPC addresses every node takes, including the warm pool the CNI keeps,
- the subnet size per zone (EKS), the node Pod range and Pod secondary range (GKE), the node subnet and pod space (AKS),
- a checks list with a link to the documentation page each rule came from,
- one click to open the result in the [VPC Subnet Planner](https://jhooq.com/tools/vpc-subnet-planner/), and Terraform, CLI and Markdown exports.

Single HTML file, no build step for users, nothing leaves the browser. The share link stores the inputs in the URL fragment.

## The rules it applies

| Cloud and mode | Max pods per node | What a node takes from your network | Source |
|---|---|---|---|
| EKS, VPC CNI secondary IPs | `ENIs x (IPs per ENI - 1) + 2`; managed node groups cap at 110 (< 30 vCPU) or 250 | every attached ENI is fully allocated; `WARM_ENI_TARGET` 1 keeps a spare ENI | [EKS instance types](https://docs.aws.amazon.com/eks/latest/userguide/choosing-instance-type.html), [VPC CNI README](https://github.com/aws/amazon-vpc-cni-k8s/blob/master/README.md) |
| EKS, prefix delegation | `slots x 16 + 2`, capped at 110 or 250 | prefixes x 16 + one primary per ENI; needs contiguous /28 blocks | [EKS prefix mode](https://docs.aws.amazon.com/eks/latest/best-practices/prefix-mode-linux.html) |
| EKS, cluster subnets | - | 6 free addresses per subnet minimum (16 recommended), 2 AZs; service CIDR /12 to /24 in a private range, no VPC overlap | [EKS network requirements](https://docs.aws.amazon.com/eks/latest/userguide/network-reqs.html), [API reference](https://docs.aws.amazon.com/eks/latest/APIReference/API_KubernetesNetworkConfigRequest.html) |
| GKE, VPC-native | 8 to 256 (default 110, Autopilot 32) | node Pod range `/(31 - ceil(log2(pods)))`; node pool Pod range >= /24; primary range reserves 4 | [GKE max Pods per node](https://cloud.google.com/kubernetes-engine/docs/how-to/flexible-pod-cidr), [VPC-native clusters](https://cloud.google.com/kubernetes-engine/docs/concepts/alias-ips) |
| AKS, Azure CNI Overlay | 250 | one VNet address per node; pods from a /24 per node out of the pod CIDR (default 10.244.0.0/16) | [AKS IP planning](https://learn.microsoft.com/en-us/azure/aks/concepts-network-ip-address-planning) |
| AKS, Azure CNI Pod Subnet | 110 | nodes in the node subnet, pods in a VNet pod subnet in batches of 16; pod subnet <= /16 | [AKS dynamic IP allocation](https://learn.microsoft.com/en-us/azure/aks/configure-azure-cni-dynamic-ip-allocation) |
| AKS, Azure CNI node subnet (legacy) | 30 | `(nodes + surge) + (nodes + surge) x maxPods`, assigned up front | [AKS IP planning](https://learn.microsoft.com/en-us/azure/aks/concepts-network-ip-address-planning) |

Reserved addresses per subnet: 5 on AWS and Azure, 4 on Google Cloud ([details](https://jhooq.com/usable-ip-addresses-subnet-aws-azure-gcp/)).

## Repository layout

```
engine.js                 pure sizing functions (Node and browser); every rule carries its source URL
data/eks-instances.json   ENIs, IPv4 per ENI, vCPU, memory for every EC2 instance type EKS knows
src/index.template.html   the page, with placeholders for the engine and the data
scripts/build.js          inlines engine + data into index.html (single file)
scripts/build-eks-data.js regenerates data/eks-instances.json from instance-info.jsonl
scripts/update-eks-data.sh  fetches the latest instance-info.jsonl from awslabs/amazon-eks-ami and rebuilds
test/engine.test.js       node --test; the published numbers are the fixtures
index.html                the built page, what jhooq.com serves
```

```bash
npm test          # 16 tests: EKS max-pods values, GKE table and 900-node example, AKS 1,581-address example ...
npm run build     # src/index.template.html + engine.js + data -> index.html
./scripts/update-eks-data.sh   # refresh the EC2 table when AWS adds instance types
```

## Where the EKS instance table comes from

`data/eks-instances.json` is generated from `nodeadm/internal/kubelet/instance-info.jsonl` in [awslabs/amazon-eks-ami](https://github.com/awslabs/amazon-eks-ami), the file the EKS AMI uses to compute `maxPods` on boot. The JSON carries the upstream commit and date in `meta`. Five upstream rows have no vCPU count (`bmn-sf1.metal`, `c5a.metal`, `c5ad.metal`, `cr1.8xlarge`, `hs1.8xlarge`); they are kept, and the cap logic treats a missing vCPU count as under 30.

## Using the engine in Node

```js
const E = require('./engine.js');
E.loadEks(require('./data/eks-instances.json'));

E.eksMaxPods('m5.large');                               // { maxPods: 29, eniFormula: 29, cap: 110, rule: 'eni', ... }
E.eksMaxPods('c5.4xlarge');                             // maxPods 110 (formula 234, managed node group cap)
E.eksPerNodeIps('m5.large', { pods: 29 });              // { ips: 30, enisUsed: 3, mode: 'secondary' }
E.eksPlan({ type: 'm5.large', nodesPerAz: 10, azs: 2 }); // perZone.prefix 23, perZone.need 316
E.gkePlan({ nodes: 900, podsPerNode: 110, surge: 0 });   // podRange.prefix 14
E.aksPlan({ mode: 'nodesubnet', nodes: 50, maxPods: 30 }); // nodeSubnet.need 1581, prefix 21
```

## What it does not model

Windows nodes, IPv6 clusters, EKS custom networking with secondary CIDRs, security groups for pods (branch ENIs), GKE multi-Pod CIDR, AKS static block allocation. Pull requests with a documented rule and a test are welcome.

## Licence

MIT. Built by [Rahul Wagh](https://jhooq.com/about/); part of the free tools at https://jhooq.com/tools/.
