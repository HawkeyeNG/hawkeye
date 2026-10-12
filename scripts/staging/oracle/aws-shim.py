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
        for p in (path(b, k), path(b, k, meta=True)):
            try:
                os.remove(p)
            except FileNotFoundError:
                pass
        return 0

    if cmd == "s3api head-object":
        b, k = opts.get("--bucket"), opts.get("--key")
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
