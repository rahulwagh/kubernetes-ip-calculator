# Changelog

## 1.0.0 - 2026-10-19

First release.

- EKS: max pods per node from the ENI formula (`ENIs x (IPs per ENI - 1) + 2`), prefix delegation (`slots x 16 + 2`) and the managed node group cap (110 under 30 vCPU, 250 above); VPC addresses per node including the warm ENI or warm prefix; subnet per zone with control-plane headroom; service CIDR rules check.
- GKE: node Pod range `31 - ceil(log2(max pods))`, Pod secondary range for the node count, node pool floor of /24, primary range with the 4 reserved addresses, GKE-managed or custom Services range, Autopilot fixed at 32 Pods per node.
- AKS: Azure CNI Overlay, Pod Subnet (batches of 16), legacy node subnet (`(n + surge) + (n + surge) x maxPods`) and kubenet; maxPods defaults and bounds.
- One-click hand-off to the VPC Subnet Planner, Terraform and CLI exports validated against hashicorp/aws 6.69.1, hashicorp/google 8.7.0 and hashicorp/azurerm 5.10.0, Markdown summary, shareable link.
- EKS instance table (1,404 types) generated from `awslabs/amazon-eks-ami` `nodeadm/internal/kubelet/instance-info.jsonl` at commit 8254d71 (2026-09-28).
