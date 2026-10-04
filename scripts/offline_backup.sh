#!/usr/bin/env bash
# OFFLINE BACKUP to a plugged-in drive (the owner's old-PC disk), everything
# Hawkeye EXCEPT secrets — those go into an encrypted archive the OWNER makes
# with scripts/offline_backup_secrets.sh (a passphrase never passes through
# Claude). Run again whenever the drive is connected: rsync copies only changes.
#
#   bash scripts/offline_backup.sh /mnt/d/Hawkeye-Backup
#
# Layout on the drive:
#   repos/     git bundles, FULL history, every branch (hawkeye + private backend)
#   files/     working trees as they are now (no node_modules, builds, secrets)
#   db/        the server's database snapshots (*.db.gz from ~/hawkeye-backups)
#   docs/      Hawkeye files from Downloads (decks, PDFs, the ADC folder), IniXien docs
#   memory/    Claude's notes for this project
#   secrets/   hawkeye-secrets-*.tar.gpg (owner-made, encrypted)
#   MANIFEST.txt, README.txt
set -uo pipefail
DEST="${1:?usage: offline_backup.sh /mnt/<drive>/Hawkeye-Backup}"
case "$DEST" in /mnt/[c-z]/*) ;; *) echo "refusing: DEST must be on a mounted drive (/mnt/<letter>/...)"; exit 2 ;; esac
[ "${DEST#/mnt/c/}" != "$DEST" ] && { echo "refusing: that is the laptop's own C: drive, not the backup drive"; exit 2; }
mkdir -p "$DEST"/{repos,files,db,docs,memory,secrets} || exit 2
STAMP=$(date +%F_%H%M); LOG="$DEST/backup-$STAMP.log"
say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }
WIN=/mnt/c/Users/HP

# SECRETS NEVER GO IN THE CLEAR. Everything matching these stays out of files/;
# offline_backup_secrets.sh puts them, encrypted, in secrets/.
SECRET_EXCL=(--exclude='.env' --exclude='.env.*' --exclude='*.env' --exclude='credentials.json'
  --exclude='google-services.json' --exclude='GoogleService-Info.plist' --exclude='*.keystore' --exclude='*.jks'
  --exclude='*.p8' --exclude='*.p12' --exclude='*.pem' --exclude='*.key' --exclude='id_*')
# Re-creatable bulk: dependencies, build outputs, caches, test output.
BULK_EXCL=(--exclude='node_modules/' --exclude='.git/' --exclude='.claude/worktrees/' --exclude='Pods/'
  --exclude='android/app/build/' --exclude='android/build/' --exclude='ios/build/' --exclude='.expo/' --exclude='.gradle/'
  --exclude='tmp/ipa/' --exclude='tmp/aab*/' --exclude='tmp/a2/' --exclude='tmp/fonttest/' --exclude='tmp/*native-web*/'
  --exclude='tmp/flowfix-*' --exclude='tmp/verify-native/' --exclude='tests/e2e/out*/' --exclude='tests/design-audit/out/'
  --exclude='build-out/' --exclude='__pycache__/' --exclude='*.pyc' --exclude='venv/' --exclude='.venv/')
# NTFS: no unix owners/permissions/symlinks; -c would be slow, size+mtime is enough.
RS=(rsync -rt --no-perms --no-owner --no-group --safe-links --modify-window=2)  # NO --delete: a file removed here stays on the drive

say "== Hawkeye offline backup -> $DEST"
say "1/5 git bundles (full history, all branches)"
for r in hawkeye:"$HOME/hawkeye" backend:"$HOME/hawkeye/backend"; do
  name=${r%%:*}; dir=${r#*:}
  git -C "$dir" bundle create "$DEST/repos/$name.bundle.tmp" --all >>"$LOG" 2>&1 \
    && git bundle verify "$DEST/repos/$name.bundle.tmp" >>"$LOG" 2>&1 \
    && mv -f "$DEST/repos/$name.bundle.tmp" "$DEST/repos/$name.bundle" \
    && say "   $name.bundle ok ($(du -h "$DEST/repos/$name.bundle" | cut -f1), HEAD $(git -C "$dir" rev-parse --short HEAD))" \
    || say "   !! $name bundle FAILED (see log)"
done

say "2/5 working trees"
"${RS[@]}" "${SECRET_EXCL[@]}" "${BULK_EXCL[@]}" "$HOME/hawkeye/" "$DEST/files/hawkeye/" >>"$LOG" 2>&1; say "   hawkeye rsync exit $?"
for s in inixien-site jol-site; do
  [ -d "$HOME/$s" ] && { "${RS[@]}" "${SECRET_EXCL[@]}" "${BULK_EXCL[@]}" "$HOME/$s/" "$DEST/files/$s/" >>"$LOG" 2>&1; say "   $s rsync exit $?"; }
done

say "3/5 database snapshots"
"${RS[@]}" --include='*.db.gz' --exclude='*' "$HOME/hawkeye-backups/" "$DEST/db/" >>"$LOG" 2>&1; say "   db rsync exit $? ($(ls "$DEST"/db/*.db.gz 2>/dev/null | wc -l) snapshots)"

say "4/5 documents"
mkdir -p "$DEST/docs/downloads"
( cd "$WIN/Downloads" && find . -maxdepth 1 -iname '*hawkeye*' -print0 ) | rsync -rt --no-perms --no-owner --no-group --from0 --files-from=- \
  "${SECRET_EXCL[@]}" "$WIN/Downloads/" "$DEST/docs/downloads/" >>"$LOG" 2>&1; say "   Downloads (Hawkeye*) rsync exit $?"
[ -d "$WIN/OneDrive/Documents/Work/IniXien" ] && { "${RS[@]}" "${SECRET_EXCL[@]}" "$WIN/OneDrive/Documents/Work/IniXien/" "$DEST/docs/IniXien/" >>"$LOG" 2>&1; say "   IniXien docs rsync exit $?"; }

say "5/5 Claude's project memory"
"${RS[@]}" "$WIN/.claude/projects/--wsl-localhost-ubuntu-home-elrio-hawkeye/memory/" "$DEST/memory/" >>"$LOG" 2>&1; say "   memory rsync exit $?"

{
  echo "Hawkeye offline backup — $STAMP"
  echo "hawkeye HEAD:  $(git -C "$HOME/hawkeye" log -1 --format='%h %ci %s')"
  echo "backend HEAD:  $(git -C "$HOME/hawkeye/backend" log -1 --format='%h %ci %s')"
  echo "newest DB:     $(ls -t "$DEST"/db/*.db.gz 2>/dev/null | head -1 | xargs -r basename)"
  echo "newest secrets archive: $(ls -t "$DEST"/secrets/*.gpg 2>/dev/null | head -1 | xargs -r basename || true)"
  echo; du -sh "$DEST"/* 2>/dev/null
  echo; echo "sha256:"; (cd "$DEST/repos" && sha256sum *.bundle)
} > "$DEST/MANIFEST.txt"
cat > "$DEST/README.txt" <<'TXT'
HAWKEYE OFFLINE BACKUP — how to restore

Code (full history):  git clone repos/hawkeye.bundle hawkeye
                      git clone repos/backend.bundle hawkeye/backend
Current files:        files/hawkeye (no node_modules: run npm ci in app, native, backend, tests/*)
Database:             db/hawkeye-YYYY-MM-DD.db.gz -> gunzip -> backend/storage/hawkeye.db
Secrets (encrypted):  gpg -d secrets/hawkeye-secrets-YYYY-MM-DD.tar.gpg | tar -x
                      (passphrase: the owner's; contains ~/hawkeye-secrets, ~/.config/hawkeye,
                      ~/.ssh, backend/.env and the other .env files, store-signing keys)
Docs:                 docs/downloads (decks, PDFs, ADC folder), docs/IniXien
TXT
say "done — $(du -sh "$DEST" | cut -f1) on the drive; MANIFEST.txt written"
