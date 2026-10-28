# Changelog

## 1.3.2 - 2026-10-28

- Step 1 is "Cloud and network": the cloud plus the VPC CIDR (EKS) or the VNet address space (AKS, new, share link key `vn`); GKE explains that its VPC has no range of its own. The zone subnets (EKS), node and pod subnets (AKS) are now named from that block in the diagram, the ranges table and the exports (10.0.0.0/24, 10.0.1.0/24, ... or 10.50.0.0/27 and 10.50.16.0/20), and AKS gets the same fit check as EKS.
- A chosen common case stays selected (share link key `pr`). Changing a value afterwards keeps it selected with an "edited" marker and a note that names what changed; clicking the case again resets it. Switching cloud clears it.

## 1.3.1 - 2026-10-28

- VPC CIDR is an input (step 4, EKS). The diagram label, the Terraform `vpc_cidr` and `cidrsubnet` newbits, the eksctl `vpc.cidr`, the service CIDR overlap check and the VPC Subnet Planner hand-off use it instead of a hard-coded 10.0.0.0/16, and a check reports whether the zone subnets fit (blocking when they do not, a warning above 75%). Share link key `vp`. Subnet sizing itself never depended on the VPC size.
- The chosen common case stays highlighted while steps 3 to 5 still match it and clears when a value moves away from it; the quick instance-type chips show the current type the same way.
- AWS, Google Cloud and Azure marks on the cloud cards (devicon, MIT), with a trademark note in the footer.

## 1.3.0 - 2026-10-28

- Guided layout: the inputs are five numbered steps (cloud, common case, instance type or mode, nodes and zones, pods per node) with the current step highlighted and a "Next" link under each; everything else (custom networking, OS, IP family, managed node group, growth headroom, service CIDR check) sits under "More options".
- The result opens with one headline number (subnet per zone on EKS, Pod secondary range on GKE, node or pod subnet on AKS) and a one-sentence plan, then the KPI tiles.
- New "How the cluster looks" diagram, drawn as SVG from the engine result: VPC, zones, subnets, one tile per node with a square per address (ENI primary, pod, warm, free slot) or a bar per /28 prefix; node and pod subnets for custom networking; the /80 IPv6 prefix on IPv6 clusters; GKE primary and Pod ranges with a block per node; AKS node subnet plus pod subnet, pod CIDR outside the VNet, or pre-assigned pod addresses on legacy CNI; service CIDR shown outside the VPC. Nodes beyond the drawn ones are summarised as "+N".
- Answer panel is sticky on desktop; on phones a bottom bar shows the headline and jumps to the result. Ranges, checks and exports moved below the fold; the arithmetic is folded under "Show the arithmetic".
- No engine change; share links from 1.2.x still load.

## 1.2.1 - 2026-10-27

- Page title, meta description, Open Graph title and heading now lead with "EKS, GKE and AKS IP Calculator", the words people search for (Search Console showed impressions for "eks calculator", "gke calculator" and "aks calculator" at positions 6 to 16 with the old title cut off before them). SoftwareApplication JSON-LD gains `alternateName`. No engine change.

## 1.2.0 - 2026-10-21

- Windows node OS: single-ENI rule (`IPs per ENI - 1`, `x 16` with Windows prefix delegation, kubelet default 110) with the Windows IPAM warm pool (warm-ip-target 1, minimum-ip-target 3); the AWS userguide and best-practices examples (m5.large 9 / 144, c5.large 144) are test fixtures.
- IPv6 IP family: prefix delegation forced, max pods from the prefix formula and cap (m5.large 434 -> 110), one IPv4 per node plus control plane in the IPv4 subnet, /56 VPC -> /64 per subnet -> /80 per node; custom networking blocked; Terraform export with `assign_generated_ipv6_cidr_block`, `ipv6_cidr_block`, `ip_family = "ipv6"` (validated on hashicorp/aws 6.69.1), eksctl `ipFamily: IPv6`.
- Share link keys `os` (l/w) and `v6`; two presets; two FAQ entries.

## 1.1.0 - 2026-10-20

- EKS custom networking mode: max pods from `(ENIs - 1) x (IPs per ENI - 1) + 2` (and `x 16` with prefix delegation), matching the AWS best-practices example (m5.large: 20, or 290 with prefixes before the 110 cap).
- Separate node subnet (1 address per node + control plane) and per-zone pod subnet carved from a secondary CIDR in 100.64.0.0/10; warns when the pod subnets need more than one /16 secondary block (5 IPv4 CIDR blocks per VPC by default).
- Checks: max pods drop, verify allocatable pods on the nodes, one ENIConfig per zone, new nodes only.
- Exports: Terraform with `aws_vpc_ipv4_cidr_block_association`, pod subnets and the vpc-cni add-on settings (validated on hashicorp/aws 6.69.1 for the single-block, per-zone-/16 and prefix-delegation cases); CLI tab with `associate-vpc-cidr-block`, `create-subnet`, the `aws-node` env and one ENIConfig per zone; Markdown summary; share link key `cn`.
- Preset "Custom networking: m5.2xlarge, Pods in 100.64" and a new FAQ entry.

## 1.0.0 - 2026-10-19

First release.

- EKS: max pods per node from the ENI formula (`ENIs x (IPs per ENI - 1) + 2`), prefix delegation (`slots x 16 + 2`) and the managed node group cap (110 under 30 vCPU, 250 above); VPC addresses per node including the warm ENI or warm prefix; subnet per zone with control-plane headroom; service CIDR rules check.
- GKE: node Pod range `31 - ceil(log2(max pods))`, Pod secondary range for the node count, node pool floor of /24, primary range with the 4 reserved addresses, GKE-managed or custom Services range, Autopilot fixed at 32 Pods per node.
- AKS: Azure CNI Overlay, Pod Subnet (batches of 16), legacy node subnet (`(n + surge) + (n + surge) x maxPods`) and kubenet; maxPods defaults and bounds.
- One-click hand-off to the VPC Subnet Planner, Terraform and CLI exports validated against hashicorp/aws 6.69.1, hashicorp/google 8.7.0 and hashicorp/azurerm 5.10.0, Markdown summary, shareable link.
- EKS instance table (1,404 types) generated from `awslabs/amazon-eks-ami` `nodeadm/internal/kubelet/instance-info.jsonl` at commit 8254d71 (2026-09-28).
