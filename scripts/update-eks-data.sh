#!/usr/bin/env bash
# Refreshes data/eks-instances.json from the EKS AMI repository and rebuilds index.html.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p src-data
curl -sSf -o src-data/instance-info.jsonl https://raw.githubusercontent.com/awslabs/amazon-eks-ami/main/nodeadm/internal/kubelet/instance-info.jsonl
commit=$(curl -sSf "https://api.github.com/repos/awslabs/amazon-eks-ami/commits?path=nodeadm/internal/kubelet/instance-info.jsonl&per_page=1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s)[0];console.log(c.sha.slice(0,7)+" "+c.commit.committer.date.slice(0,10))})')
node scripts/build-eks-data.js src-data/instance-info.jsonl ${commit% *} ${commit#* }
node --test test/
node scripts/build.js
