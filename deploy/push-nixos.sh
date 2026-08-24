#!/usr/bin/env bash
# Deploy the current checkout to the NixOS host (k3s) over the SSH bridge
# (ProxyJump through spark, configured in ~/.ssh/config as host "nixos").
#
# Usage: ./deploy/push-nixos.sh [--restart]
#   Copies web/, ws-proxy/ (incl. node_modules), assets/game/, lib/,
#   deploy/k8s/ to /var/lib/k3s-data/xonweb, applies the manifest, then
#   (with --restart, or when the manifest changed) rolls the deployment.
#
# Run from the repo root.

set -euo pipefail

if [ ! -f web/server.js ] || [ ! -d .git ]; then
	echo "error: run from the xonweb repo root" >&2
	exit 1
fi

DEST=nixos:/var/lib/k3s-data/xonweb
RESTART=0
[ "${1:-}" = "--restart" ] && RESTART=1

rsync() { command rsync -rlptD --info=stats1 "$@"; }

echo "== syncing web/"
rsync web/ "$DEST/web/"

echo "== syncing ws-proxy/"
rsync ws-proxy/ "$DEST/ws-proxy/"

echo "== syncing lib/"
rsync lib/ "$DEST/lib/"

echo "== syncing assets/game/"
rsync assets/game/ "$DEST/assets/game/"

# Official map packs for /mapfind (server.js falls back to xonotic/data/).
# Outside assets/ on purpose: /filelist (first-run cache) must not include them.
echo "== syncing xonotic/data map packs"
ssh -o BatchMode=yes nixos 'mkdir -p /var/lib/k3s-data/xonweb/xonotic/data'
rsync xonotic/data/*.pk3 "$DEST/xonotic/data/"

echo "== syncing deploy/k8s/"
ssh -o BatchMode=yes nixos 'mkdir -p /var/lib/k3s-data/xonweb/deploy/k8s'
rsync deploy/k8s/ "$DEST/deploy/k8s/"

# Copy the error sink into the pod path even though the checkout is mounted
# read-only (the pods get a writable emptyDir at /xonweb/data).
ssh -o BatchMode=yes nixos 'mkdir -p /var/lib/k3s-data/xonweb/data && chmod 777 /var/lib/k3s-data/xonweb/data'

MANIFEST_SHA_BEFORE=$(ssh -o BatchMode=yes nixos 'sha256sum /var/lib/k3s-data/xonweb/deploy/k8s/xonweb.yaml 2>/dev/null | cut -d" " -f1' || true)

ssh -o BatchMode=yes nixos '
	set -e
	if command -v k3s >/dev/null 2>&1; then K=k3s
	else K="sudo -n k3s"; fi
	$K kubectl apply -f /var/lib/k3s-data/xonweb/deploy/k8s/xonweb.yaml
'

MANIFEST_SHA_AFTER=$(ssh -o BatchMode=yes nixos 'sha256sum /var/lib/k3s-data/xonweb/deploy/k8s/xonweb.yaml | cut -d" " -f1')
if [ "$RESTART" = 1 ] || [ "$MANIFEST_SHA_BEFORE" != "$MANIFEST_SHA_AFTER" ]; then
	echo "== restarting deployment"
	ssh -o BatchMode=yes nixos '
		set -e
		if command -v k3s >/dev/null 2>&1; then K=k3s
		else K="sudo -n k3s"; fi
		$K kubectl rollout restart deployment/xonweb -n xonweb
		$K kubectl rollout status  deployment/xonweb -n xonweb --timeout=120s
	'
else
	echo "== manifest unchanged; no restart needed"
fi

echo "== health check"
sleep 3
ssh -o BatchMode=yes nixos '
	if command -v k3s >/dev/null 2>&1; then K=k3s
	else K="sudo -n k3s"; fi
	$K kubectl get pods -n xonweb
	curl -fsS http://127.0.0.1:30092/hello
'

echo "== done"
