#!/usr/bin/env python3
"""Regenerate the donation-address QR SVGs in this directory.

    pip install --break-system-packages qrcode   # pure-Python, SVG needs no PIL
    python3 app/qr/generate.py

Static build assets — no QR library ships to the web; support.html just references
these <img> SVGs. Native renders the SAME strings at runtime via react-native-qrcode-svg.

CHAIN PREFIXES (so a scan routes to the right network):
  * The six EVM chains share ONE address, so each QR carries an EIP-681
    `ethereum:<addr>@<chainId>` so a scanner can pick the network:
    Ethereum 1 · Base 8453 · Polygon 137 · Monad 143 · Robinhood 4663 · HyperEVM 999.
  * Solana: `solana:` (Solana Pay).  Bitcoin: `bitcoin:` (BIP-21).
  * Sui has NO standard URI scheme, so it stays a RAW address (a `sui:` prefix would
    make some wallets fail to parse); a Sui address is self-identifying by format.

The COPY button on the page copies the RAW address, not the URI — you paste addresses
into a wallet, not URIs. After regenerating, SCAN each QR and confirm it resolves to
the exact address on the intended network before publishing.
"""
import os
import qrcode
import qrcode.image.svg

EVM = '0x00F7bE0EA4A6dF70afc32d591C53460008d28C11'
SOL = 'Ac952LkbEvNAgECtd1n7LWG11M69VbGvUJCmAVkvenQN'
BTC = 'bc1qnksyh8vvzetpjhc6kl9e7dxpa5tkk6pthehxly'
SUI = '0x0b46490cffac31ac4f08683cc1c9ab3b56c9d0e279ab18d5d26f77cdeb138fb3'

# (slug, qr_payload)
QRS = [
    ('ethereum', 'ethereum:%s@1' % EVM),
    ('base', 'ethereum:%s@8453' % EVM),
    ('polygon', 'ethereum:%s@137' % EVM),
    ('monad', 'ethereum:%s@143' % EVM),
    ('robinhood', 'ethereum:%s@4663' % EVM),
    ('hyperevm', 'ethereum:%s@999' % EVM),
    ('solana', 'solana:%s' % SOL),
    ('bitcoin', 'bitcoin:%s' % BTC),
    ('sui', SUI),  # raw — no standard Sui URI scheme
]

out = os.path.dirname(os.path.abspath(__file__))
factory = qrcode.image.svg.SvgPathImage
for slug, payload in QRS:
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=2)
    qr.add_data(payload)
    qr.make(fit=True)
    qr.make_image(image_factory=factory).save(os.path.join(out, 'qr-%s.svg' % slug))
    print('qr-%-9s v%-2d %2d modules  %s' % (slug + '.svg', qr.version, qr.modules_count, payload))
