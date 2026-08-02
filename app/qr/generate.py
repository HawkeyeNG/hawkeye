#!/usr/bin/env python3
"""Regenerate the donation-address QR SVGs in this directory.

    pip install --break-system-packages qrcode   # pure-Python, SVG needs no PIL
    python3 app/qr/generate.py

These are STATIC build assets — no QR library ships to users, just the resulting
<img> SVGs (support.html references them). The six EVM chains share one address,
so they get a single QR. Raw-address encoding, matching what wallets emit. After
regenerating, SCAN each QR and confirm it decodes to the exact address before
publishing.
"""
import os
import qrcode
import qrcode.image.svg

WALLETS = {
    'evm': '0x00F7bE0EA4A6dF70afc32d591C53460008d28C11',
    'solana': 'Ac952LkbEvNAgECtd1n7LWG11M69VbGvUJCmAVkvenQN',
    'bitcoin': 'bc1qnksyh8vvzetpjhc6kl9e7dxpa5tkk6pthehxly',
    'sui': '0x0b46490cffac31ac4f08683cc1c9ab3b56c9d0e279ab18d5d26f77cdeb138fb3',
}
out = os.path.dirname(os.path.abspath(__file__))
factory = qrcode.image.svg.SvgPathImage
for name, addr in WALLETS.items():
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=2)
    qr.add_data(addr)
    qr.make(fit=True)
    qr.make_image(image_factory=factory).save(os.path.join(out, 'qr-%s.svg' % name))
    print('qr-%s.svg  v%d  %dx%d modules' % (name, qr.version, qr.modules_count, qr.modules_count))
