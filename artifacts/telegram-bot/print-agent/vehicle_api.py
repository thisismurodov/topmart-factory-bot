import json
import urllib.error
import urllib.request
from urllib.parse import urlsplit


class VehicleApiError(RuntimeError):
    def __init__(self, status_code: int | None, message: str):
        super().__init__(message)
        self.status_code = status_code


class VehicleApiClient:
    def __init__(self, base_url: str, bot_key: str, *, timeout: int = 30):
        self.base_url = base_url.rstrip("/")
        self.bot_key = bot_key
        self.timeout = timeout
        if not self.base_url:
            raise ValueError("API_BASE_URL bo'sh")
        if not self.bot_key:
            raise ValueError("VEHICLE_DISTRIBUTION_BOT_KEY bo'sh")
        parsed = urlsplit(self.base_url)
        loopback = parsed.hostname in {"127.0.0.1", "::1", "localhost"}
        if parsed.scheme != "https" and not (
            parsed.scheme == "http" and loopback
        ):
            raise ValueError(
                "API_BASE_URL HTTPS bo'lishi kerak "
                "(faqat loopback development HTTP bo'lishi mumkin)"
            )

    def _request(
        self,
        method: str,
        path: str,
        payload: dict | None = None,
    ) -> dict:
        body = (
            json.dumps(payload, separators=(",", ":")).encode("utf-8")
            if payload is not None
            else None
        )
        request = urllib.request.Request(
            self.base_url + path,
            data=body,
            method=method,
            headers={
                "Content-Type": "application/json",
                "x-vehicle-distribution-bot-key": self.bot_key,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8")
                parsed = json.loads(raw) if raw else {}
                if not isinstance(parsed, dict):
                    raise VehicleApiError(None, "API object qaytarmadi")
                return parsed
        except urllib.error.HTTPError as exc:
            try:
                parsed = json.loads(exc.read().decode("utf-8"))
                message = str(parsed.get("error") or f"HTTP {exc.code}")
            except Exception:
                message = f"HTTP {exc.code}"
            raise VehicleApiError(exc.code, message) from exc
        except VehicleApiError:
            raise
        except Exception as exc:
            raise VehicleApiError(None, str(exc)) from exc

    def get_handoff(self, handoff_id: int) -> dict:
        return self._request(
            "GET", f"/vehicle-distribution/handoffs/{int(handoff_id)}"
        )

    def send_heartbeat(self, payload: dict) -> dict:
        return self._request(
            "POST", "/vehicle-distribution/print-agent/heartbeat", payload
        )

    def get_labels(self, handoff_id: int) -> dict:
        return self._request(
            "GET",
            f"/vehicle-distribution/handoffs/{int(handoff_id)}/labels",
        )

    def prepare_labels(self, handoff_id: int, operation_key: str) -> dict:
        return self._request(
            "POST",
            f"/vehicle-distribution/handoffs/{int(handoff_id)}/labels/prepare",
            {"operationKey": operation_key},
        )

    def confirm_printed(self, handoff_id: int, operation_key: str) -> dict:
        return self._request(
            "POST",
            (
                f"/vehicle-distribution/handoffs/{int(handoff_id)}"
                "/confirm-labels-printed"
            ),
            {"operationKey": operation_key},
        )