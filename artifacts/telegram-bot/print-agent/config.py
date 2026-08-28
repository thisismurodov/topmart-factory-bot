import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping


class ConfigError(RuntimeError):
    pass


def _parse_chat_ids(raw: str) -> frozenset[int]:
    values: set[int] = set()
    for item in raw.split(","):
        token = item.strip()
        if not token:
            continue
        try:
            values.add(int(token))
        except ValueError as exc:
            raise ConfigError(
                "ALLOWED_CHAT_IDS faqat vergul bilan ajratilgan raqamlar bo'lishi kerak"
            ) from exc
    return frozenset(values)


@dataclass(frozen=True)
class PrintAgentConfig:
    telegram_bot_token: str
    allowed_chat_ids: frozenset[int]
    printer_name: str
    api_base_url: str
    vehicle_bot_key: str
    job_db_path: str
    agent_id: str
    heartbeat_interval_seconds: int


def load_config(environ: Mapping[str, str] | None = None) -> PrintAgentConfig:
    env = os.environ if environ is None else environ
    try:
        heartbeat_interval_seconds = int(
            env.get("PRINT_AGENT_HEARTBEAT_SECONDS", "60").strip()
        )
    except ValueError as exc:
        raise ConfigError(
            "PRINT_AGENT_HEARTBEAT_SECONDS butun son bo'lishi kerak"
        ) from exc
    config = PrintAgentConfig(
        telegram_bot_token=env.get("TELEGRAM_BOT_TOKEN", "").strip(),
        allowed_chat_ids=_parse_chat_ids(env.get("ALLOWED_CHAT_IDS", "")),
        printer_name=env.get("PRINTER_NAME", "").strip(),
        api_base_url=env.get("API_BASE_URL", "").strip(),
        vehicle_bot_key=env.get("VEHICLE_DISTRIBUTION_BOT_KEY", "").strip(),
        job_db_path=env.get(
            "PRINT_JOB_DB",
            str(Path(__file__).with_name("print_jobs.sqlite3")),
        ).strip(),
        agent_id=env.get("PRINT_AGENT_ID", "").strip(),
        heartbeat_interval_seconds=heartbeat_interval_seconds,
    )
    missing: list[str] = []
    if not config.telegram_bot_token:
        missing.append("TELEGRAM_BOT_TOKEN")
    if not config.allowed_chat_ids:
        missing.append("ALLOWED_CHAT_IDS")
    if not config.printer_name:
        missing.append("PRINTER_NAME")
    if not config.api_base_url:
        missing.append("API_BASE_URL")
    if not config.vehicle_bot_key:
        missing.append("VEHICLE_DISTRIBUTION_BOT_KEY")
    if not config.job_db_path:
        missing.append("PRINT_JOB_DB")
    if not config.agent_id:
        missing.append("PRINT_AGENT_ID")
    if config.heartbeat_interval_seconds < 15:
        raise ConfigError("PRINT_AGENT_HEARTBEAT_SECONDS kamida 15 bo'lishi kerak")
    if config.heartbeat_interval_seconds > 120:
        raise ConfigError("PRINT_AGENT_HEARTBEAT_SECONDS ko'pi bilan 120 bo'lishi kerak")
    if missing:
        raise ConfigError(
            "Majburiy sozlamalar yo'q yoki bo'sh: " + ", ".join(missing)
        )
    return config
