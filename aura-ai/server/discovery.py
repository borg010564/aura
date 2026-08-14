"""Answers LAN discovery probes so the phone can find this server without a hardcoded IP.

Home routers hand out new DHCP addresses periodically, which meant re-typing the server URL
into the app every time it changed. Instead the app broadcasts a small UDP probe and this
responder replies with the current URL, recomputed fresh each time so it stays correct even
if the address changes while the server is running.
"""

import socket
import threading

DISCOVERY_PORT = 41234
PROBE = b"AURA_DISCOVER_V1"


def lan_ip(peer: str | None = None) -> str:
    """This machine's address *as the phone can reach it*.

    Asking the OS which address reaches the internet (the old behaviour) picks whatever
    holds the default route. On a PC with a VPN or mobile-broadband adapter that's the
    wrong one: this machine handed out a carrier-grade-NAT address (100.64.x.x) that the
    phone had no route to, so the app quietly gave up on the server and fell back to
    running standalone — the slower path — with nothing to show that it had.

    Routing to the phone's own address instead picks the interface on its subnet.
    """
    for target in ([(peer, 9)] if peer else []) + [("8.8.8.8", 80)]:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(target)
            return s.getsockname()[0]
        except OSError:
            continue
        finally:
            s.close()
    return "127.0.0.1"


def start_discovery_responder(scheme: str, port: int) -> threading.Thread | None:
    def run() -> None:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("", DISCOVERY_PORT))
        except OSError as exc:
            print(f"[aura] discovery disabled (port {DISCOVERY_PORT} unavailable): {exc}")
            return
        print(f"[aura] discovery responder listening on UDP {DISCOVERY_PORT}")
        while True:
            try:
                data, addr = sock.recvfrom(1024)
            except OSError:
                break
            if data.strip() != PROBE:
                continue
            url = f"{scheme}://{lan_ip(addr[0])}:{port}"
            try:
                sock.sendto(url.encode(), addr)
                print(f"[aura] discovery: told {addr[0]} to use {url}")
            except OSError:
                pass

    thread = threading.Thread(target=run, daemon=True, name="aura-discovery")
    thread.start()
    return thread
