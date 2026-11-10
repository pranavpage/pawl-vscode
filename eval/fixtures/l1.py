import requests

API = "https://alarms.example.com/v1"


def fetch_page(cfg, page):
    r = requests.get(f"{cfg['base']}/alarms", params={"page": pa<|>
    r.raise_for_status()
    return r.json()
