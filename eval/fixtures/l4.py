import os
import sys
from dataclasses import dataclass

import requests

API = "https://alarms.example.com/v1"


@dataclass
class Alarm:
    id: str
    machine: str
    severity: int
    message: str


def load_config():
    key = os.environ.get("ALARM_KEY")
    if not key:
        sys.exit("ALARM_KEY missing")
    return {"key": key, "base": os.environ.get("ALARM_BASE", API)}


def fetch_all(cfg) -> list[Alarm]:
    # TODO: fetch every page of open alarms, stop when a page is empty, map to Alarm
    <|>


def main():
    cfg = load_config()
    alarms = fetch_all(cfg)
