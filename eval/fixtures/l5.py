# PLAN
# [x] 1. Load config from env, fail fast if ALARM_KEY is missing
# [x] 2. Fetch open alarms from the API, paginate
# [x] 3. Group alarms by machine, sort by severity
# [ ] 4. Print a summary table: machine, alarm count, worst severity
# END PLAN
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
    alarms, page = [], 1
    while True:
        r = requests.get(f"{cfg['base']}/alarms", params={"page": page}, headers={"Authorization": cfg["key"]})
        r.raise_for_status()
        rows = r.json()
        if not rows:
            return alarms
        alarms += [Alarm(**row) for row in rows]
        page += 1


def group_by_machine(alarms: list[Alarm]) -> dict[str, list[Alarm]]:
    groups: dict[str, list[Alarm]] = {}
    for alarm in alarms:
        groups.setdefault(alarm.machine, []).append(alarm)
    for group in groups.values():
        group.sort(key=lambda a: a.severity, reverse=True)
    return groups


def main():
    cfg = load_config()
    groups = group_by_machine(fetch_all(cfg))
    <|>


if __name__ == "__main__":
    main()
