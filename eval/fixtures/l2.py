import requests


def fetch_page(cfg, page):
    r = requests.get(
        f"{cfg['base']}/alarms",
        <|>
    r.raise_for_status()
    return r.json()
