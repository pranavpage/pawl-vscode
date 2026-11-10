from dataclasses import dataclass


@dataclass
class Alarm:
    id: str
    machine: str
    severity: int
    message: str


def group_by_machine(alarms: list[Alarm]) -> dict[str, list[Alarm]]:
    """Group alarms by machine, each group sorted by severity, highest first."""
    <|>


def main():
    pass
