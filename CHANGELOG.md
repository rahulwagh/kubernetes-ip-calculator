# Changelog

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
