#!/usr/bin/env python3
"""A stand-in for the `aws` command on a staging host that is NOT on AWS.

bootstrap.sh and the units it installs call the AWS CLI for three things: the
deploy bundle and DB backups in S3, and the secrets in SSM Parameter Store.
scripts/staging/oracle.sh installs this file as /usr/local/bin/aws, so the same
on-host setup runs unchanged on Oracle. It implements only what those scripts
call, and refuses anything else:

  s3 cp SRC DST [--metadata k=v,...]      s3 rm s3://B/K
  s3api head-object --bucket B --key K [--query Metadata.<name>]
  s3api list-objects-v2 --bucket B --prefix P --query 'Contents[].Key' --output text
  ssm get-parameters-by-path --path P --recursive --with-decryption --output json

Objects live under /var/lib/hawkeye/objstore/<bucket>/<key>: ON THIS BOX'S OWN
DISK. That makes the "second copy" of the database no protection at all, which
is acceptable for a throwaway load-test host and for nothing else.
Parameters are files under /etc/hawkeye/params (root only), one per name.
"""
import json
import os
import shutil
import sys

ROOT = os.environ.get("AWS_SHIM_ROOT", "/var/lib/hawkeye/objstore")
PARAMS = os.environ.get("AWS_SHIM_PARAMS", "/etc/hawkeye/params")


def die(msg, code=2):
    print(f"aws (hawkeye stand-in): {msg}", file=sys.stderr)
    sys.exit(code)


def split(url):
    if not url.startswith("s3://"):
        return None
    bucket, _, key = url[5:].partition("/")
    if not bucket or not key or ".." in key.split("/") or key.startswith("/"):
        die(f"bad object address {url}")
    return bucket, key


def path(bucket, key, meta=False):
    return os.path.join(ROOT, ".meta" if meta else "", bucket, key + (".json" if meta else ""))


def put(src, bucket, key, metadata):
    dst = path(bucket, key)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = dst + ".part"
    shutil.copyfile(src, tmp)
    os.replace(tmp, dst)
    mp = path(bucket, key, meta=True)
    os.makedirs(os.path.dirname(mp), exist_ok=True)
    with open(mp, "w") as f:
        json.dump(metadata, f)


def meta_of(bucket, key):
    try:
        return json.load(open(path(bucket, key, meta=True)))
    except (OSError, ValueError):
        return {}


# OFF THE BOX: everything under backup/ (the hourly copy and peak mode's 10-minute snapshots) goes
# to the R2 bucket the app already has keys for (S3_* in /run/hawkeye/app.env; BACKUP_S3_BUCKET to
# use another bucket), through backend/scripts/r2cli.mjs. Without those keys it stays on this disk
# as before. The deploy bundle stays local either way.
R2CLI = os.environ.get("AWS_SHIM_R2CLI", "/opt/hawkeye/current/backend/scripts/r2cli.mjs")
APP_ENV_FILE = os.environ.get("AWS_SHIM_APP_ENV", "/run/hawkeye/app.env")


def remote_env():
    try:
        lines = open(APP_ENV_FILE).read().splitlines()
    except OSError:
        return None
    env = dict(l.split("=", 1) for l in lines if "=" in l and not l.startswith("#"))
    keys = ("S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY")
    if not all(env.get(k) for k in keys) or not os.path.isfile(R2CLI):
        return None
    out = {k: env[k] for k in keys + ("S3_REGION", "BACKUP_S3_BUCKET") if env.get(k)}
    out["PATH"] = os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin")
    return out


def remote(key, *args):
    """Run r2cli for an object under backup/; None when this key stays local."""
    if not key.startswith("backup/"):
        return None
    env = remote_env()
    if env is None:
        return None
    import subprocess
    return subprocess.run(["/usr/local/bin/node", R2CLI, *args], env=env).returncode


def main(argv):
    opts, rest, i = {}, [], 0
    flags = {"--only-show-errors", "--recursive", "--with-decryption"}
    while i < len(argv):
        a = argv[i]
        if a in flags:
            opts[a] = True
        elif a.startswith("--"):
            if i + 1 >= len(argv):
                die(f"{a} needs a value")
            opts[a] = argv[i + 1]
            i += 1
        else:
            rest.append(a)
        i += 1
    cmd = " ".join(rest[:2])

    if cmd == "s3 cp" and len(rest) == 4:
        src, dst = split(rest[2]), split(rest[3])
        metadata = dict(kv.split("=", 1) for kv in opts.get("--metadata", "").split(",") if "=" in kv)
        if src and dst:
            rc = remote(dst[1], "copy", src[1], dst[1]) if src[1].startswith("backup/") else None
        elif dst:
            rc = remote(dst[1], "put", rest[2], dst[1], json.dumps(metadata))
        else:
            rc = remote(src[1], "get", src[1], rest[3]) if src else None
        if rc is not None:
            return rc
        if src and dst:                                   # object to object: the metadata travels
            if not os.path.isfile(path(*src)):
                die(f"no such object {rest[2]}", 1)
            put(path(*src), dst[0], dst[1], meta_of(*src))
        elif dst:
            put(rest[2], dst[0], dst[1], metadata)
        elif src:
            if not os.path.isfile(path(*src)):
                die(f"no such object {rest[2]}", 1)
            shutil.copyfile(path(*src), rest[3])
        else:
            die("s3 cp needs an s3:// address on one side")
        return 0

    if cmd == "s3 rm" and len(rest) == 3:
        b, k = split(rest[2]) or die("s3 rm needs an s3:// address")
        rc = remote(k, "rm", k)
        if rc is not None:
            return rc
        for p in (path(b, k), path(b, k, meta=True)):
            try:
                os.remove(p)
            except FileNotFoundError:
                pass
        return 0

    if cmd == "s3api head-object":
        b, k = opts.get("--bucket"), opts.get("--key")
        q = opts.get("--query", "")
        rc = remote(k or "", "head", k, *([q[len("Metadata."):]] if q.startswith("Metadata.") else []))
        if rc is not None:
            return rc
        if not b or not k or not os.path.isfile(path(b, k)):
            die("Not Found", 254)
        m = meta_of(b, k)
        q = opts.get("--query", "")
        if q.startswith("Metadata."):
            print(m.get(q[len("Metadata."):], "None"))
        else:
            print(json.dumps({"ContentLength": os.path.getsize(path(b, k)), "Metadata": m}))
        return 0

    if cmd == "s3api list-objects-v2":
        b, prefix = opts.get("--bucket"), opts.get("--prefix", "")
        if not b or opts.get("--query") != "Contents[].Key" or opts.get("--output") != "text":
            die("list-objects-v2 is supported only as --query 'Contents[].Key' --output text")
        rc = remote(prefix, "list", prefix)
        if rc is not None:
            return rc
        base, keys = os.path.join(ROOT, b), []
        for d, _dirs, files in os.walk(base):
            for f in files:
                key = os.path.relpath(os.path.join(d, f), base)
                if key.startswith(prefix) and not key.endswith(".part"):
                    keys.append(key)
        print("\t".join(sorted(keys)) if keys else "None")
        return 0

    if cmd == "ssm get-parameters-by-path":
        prefix = (opts.get("--path") or die("--path is required")).rstrip("/")
        out = []
        for d, _dirs, files in os.walk(PARAMS):
            for f in files:
                rel = os.path.relpath(os.path.join(d, f), PARAMS)
                out.append({"Name": f"{prefix}/{rel}", "Type": "SecureString",
                            "Value": open(os.path.join(d, f)).read().rstrip("\n")})
        print(json.dumps({"Parameters": sorted(out, key=lambda p: p["Name"])}))
        return 0

    die(f"not supported here: {' '.join(argv)[:120]}")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
