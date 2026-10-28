#!/bin/sh
set -eu
umask 077
key=/run/secrets/master_key
if [ -L "$key" ]; then
  echo 'Refusing a linked master key.' >&2
  exit 1
fi
if [ -e "$key" ]; then
  test -f "$key" && test -s "$key" || { echo 'Invalid existing master key; preserve data and inspect.' >&2; exit 1; }
else
  if [ -n "$(ls -A /var/lib/zhihui-web)" ]; then
    echo 'Existing data without its master key: restore the original key; initialization stopped.' >&2
    exit 1
  fi
  /usr/local/bin/zhihui-web init-key
fi
chown 10001:10001 /var/lib/zhihui-web /backup /run/secrets "$key"
chmod 700 /var/lib/zhihui-web /backup /run/secrets
chmod 400 "$key"
echo 'Persistent volumes ready; existing key preserved.'
