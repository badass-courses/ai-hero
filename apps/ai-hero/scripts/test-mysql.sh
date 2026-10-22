#!/usr/bin/env bash
# Disposable MySQL 8.4 for the guarded *.mysql.test.ts suites. Test data only.
#
#   scripts/test-mysql.sh up            start (or reuse) this worktree's server
#   scripts/test-mysql.sh url           print the server URL
#   scripts/test-mysql.sh schema <db>   create <db> and apply the app schema
#   scripts/test-mysql.sh down          remove this worktree's container only
#
# One container per worktree: `aih-test-mysql-<worktree basename>`, labelled
# `aih-test-mysql=1`, bound to 127.0.0.1 on a Docker-chosen free port, `--rm`
# and no volume. Same image and root password as CI
# (.github/workflows/evergreen-journey-mysql.yaml).
set -euo pipefail

IMAGE=mysql:8.4
PASSWORD=aih_test_password
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WORKTREE=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)
NAME="aih-test-mysql-$(basename "$WORKTREE" | tr -c 'a-zA-Z0-9_.\n-' '-')"

# A shell started before joel joined the docker group can't reach the socket.
# Re-run once under `sg docker` when the user is a member.
if ! docker version >/dev/null 2>&1; then
	if [ -z "${AIH_TEST_MYSQL_SG:-}" ] && command -v sg >/dev/null &&
		getent group docker | cut -d: -f4 | tr ',' '\n' | grep -qx "$(id -un)"; then
		export AIH_TEST_MYSQL_SG=1
		exec sg docker -c "$(printf '%q ' "$0" "$@")"
	fi
	echo "test-mysql: cannot reach Docker. Check that the daemon runs and you can use its socket." >&2
	exit 1
fi

owned_container() {
	# Exact name and our label; anything else is someone else's container.
	[ "$(docker inspect -f '{{index .Config.Labels "aih-test-mysql"}}' "$NAME" 2>/dev/null || true)" = 1 ]
}

server_url() {
	local port
	port=$(docker port "$NAME" 3306/tcp | grep '^127.0.0.1:' | head -1 | cut -d: -f2)
	[ -n "$port" ] || { echo "test-mysql: $NAME has no loopback port" >&2; exit 1; }
	echo "mysql://root:${PASSWORD}@127.0.0.1:${port}/mysql"
}

wait_healthy() {
	local status
	for _ in $(seq 1 90); do
		status=$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null || echo missing)
		case "$status" in
		healthy) return 0 ;;
		missing) echo "test-mysql: $NAME exited during startup" >&2; exit 1 ;;
		esac
		sleep 2
	done
	echo "test-mysql: $NAME not healthy after 180s (last: $status)" >&2
	exit 1
}

cmd=${1:-}
case "$cmd" in
up)
	if ! owned_container; then
		if docker inspect "$NAME" >/dev/null 2>&1; then
			echo "test-mysql: a container named $NAME exists without our label; leaving it alone" >&2
			exit 1
		fi
		docker run -d --rm --name "$NAME" --label aih-test-mysql=1 \
			-e MYSQL_ROOT_PASSWORD="$PASSWORD" \
			-p 127.0.0.1::3306 \
			--health-cmd="mysqladmin ping -h 127.0.0.1 -uroot -p$PASSWORD --silent" \
			--health-interval=2s --health-timeout=5s --health-retries=60 \
			"$IMAGE" >/dev/null
	fi
	wait_healthy
	echo "AIH_TEST_MYSQL_SERVER_URL=$(server_url)"
	;;
url)
	owned_container || { echo "test-mysql: $NAME is not running; run up first" >&2; exit 1; }
	echo "AIH_TEST_MYSQL_SERVER_URL=$(server_url)"
	;;
schema)
	db=${2:-}
	case "$db" in
	mysql | sys | information_schema | performance_schema | '') db=invalid! ;;
	esac
	[[ "$db" =~ ^[a-z0-9_]{1,64}$ ]] || {
		echo "usage: $0 schema <db>   (a-z, 0-9, _; not a system schema)" >&2
		exit 2
	}
	owned_container || { echo "test-mysql: $NAME is not running; run up first" >&2; exit 1; }
	docker exec "$NAME" mysql -uroot -p"$PASSWORD" -e "CREATE DATABASE IF NOT EXISTS \`$db\`" 2>/dev/null
	url="$(server_url | sed "s#/mysql\$#/$db#")"
	(cd "$SCRIPT_DIR/.." && node scripts/test-mysql-schema.mjs "$url")
	echo "AIH_TEST_MYSQL_URL=$url"
	;;
down)
	if owned_container; then
		docker rm -f "$NAME" >/dev/null
		echo "test-mysql: removed $NAME"
	else
		echo "test-mysql: no $NAME container to remove"
	fi
	;;
*)
	echo "usage: $0 up | url | schema <db> | down" >&2
	exit 2
	;;
esac
