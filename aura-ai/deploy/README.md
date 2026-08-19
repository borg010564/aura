# Running Aura on a VPS

The LAN setup expects a PC on the same WiFi: the phone finds it by UDP broadcast and reaches
it over plain HTTP. Neither survives the trip to a public host, so this setup swaps both —
the phone arrives by hostname, and Caddy terminates TLS in front of the app.

Written against Ubuntu 24.04 and 26.04 on a $5/mo box (Vultr, Linode, DigitalOcean — any of
them). 1 GB RAM is ample; the app is one Python process holding a WebSocket.

On 26.04 the system Python is 3.14, which the server runs on fine — the one thing it changes
is that pip refuses to install outside a virtualenv (PEP 668), and the steps below use one
anyway.

**Region:** put it wherever. The instinct is to pick one near you, but the audio's real
destination is OpenAI in the US, so a US box and a local one land within a few milliseconds
of each other. Avoid anywhere that makes the traffic cross an ocean twice — Singapore, from
Australia, is the worst of both.

## 1. DNS first

Caddy can't get a certificate for a name that doesn't resolve yet, so do this before
installing anything.

`cactusdesign.au` is registered at OnlyDomains but its DNS is served by the web host —
the zone delegates to `ns1/ns2/ns3.hostingww.com`. So the record goes in that host's
**cPanel > Zone Editor**, not in the registrar's panel. Adding it at OnlyDomains has no
effect while the delegation points elsewhere.

In cPanel > Zone Editor for `cactusdesign.au`, add:

| Type | Name   | Value             |
|------|--------|-------------------|
| A    | `aura` | your server's IPv4 |

Add a `AAAA` record for `aura` too if the box has IPv6. Wait for it to resolve:

    dig +short aura.cactusdesign.au

Nothing below will work until that prints your server's IP.

## 2. The box

    sudo adduser --system --group --home /opt/aura aura
    sudo apt update && sudo apt install -y python3-venv git

    sudo -u aura git clone https://github.com/borg010564/aura.git /opt/aura
    cd /opt/aura/aura-ai/server
    sudo -u aura python3 -m venv .venv
    sudo -u aura .venv/bin/pip install -r requirements.txt

## 3. Configuration

    sudo -u aura cp .env.example .env
    sudo -u aura nano .env

Set `OPENAI_API_KEY`, and add an access token — any long random string:

    openssl rand -hex 24

    AURA_TOKEN=<paste it here>

**`AURA_TOKEN` is the one line that matters on a public host.** Every `/ws` connection opens
a session billed to your OpenAI key, and without a token anyone who finds the hostname can
run up that bill. Leave it unset and the endpoint stays open — correct on a home LAN, and a
standing invoice on the internet.

Then lock the file down, since it now holds two secrets:

    sudo chmod 600 .env

## 4. Service and proxy

    sudo cp /opt/aura/aura-ai/deploy/aura.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now aura
    systemctl status aura

Caddy, from its own repository rather than Ubuntu's — the packaged version lags, and on a
recently released Ubuntu it may not be there at all:

    sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
    sudo apt update && sudo apt install -y caddy

    sudo cp /opt/aura/aura-ai/deploy/Caddyfile /etc/caddy/Caddyfile
    sudo systemctl reload caddy

The certificate is issued on the first request and renews itself thereafter.

## 5. The phone

Open this once, with the token from `.env`:

    https://aura.cactusdesign.au/?k=YOUR_TOKEN

The page stores the token and strips it from the address bar, so bookmark the plain
`https://aura.cactusdesign.au/` afterwards. Every phone you want to use needs that one visit.

Because the origin is HTTPS, the microphone and camera work with no flags and no self-signed
certificate — the problem that made the LAN setup awkward doesn't exist here.

## Checks

    curl -I https://aura.cactusdesign.au/          # 200
    sudo journalctl -u aura -f                     # live log

A connection with a bad token logs `refused a /ws connection with a bad or missing token`
and returns HTTP 403. Confirm the gate is really on before you leave it running:

    curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
         -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGVzdA==" \
         https://aura.cactusdesign.au/ws

That must come back 403. A 101 means `AURA_TOKEN` didn't take, and the server is open.

## Updating

    cd /opt/aura && sudo -u aura git pull
    sudo -u aura aura-ai/server/.venv/bin/pip install -r aura-ai/server/requirements.txt
    sudo systemctl restart aura

## Costs

The VPS is the small number. OpenAI Realtime bills per minute of audio and will pass $5/mo
with regular conversation, so watch usage at platform.openai.com rather than the hosting
bill — and set a spend limit there while you're at it.
